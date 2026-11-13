import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignedDocumentProps } from "@/emails/templates/signed-document"

const { env, post, sendMail, createTestAccount } = vi.hoisted(() => ({
  env: { AZURE_EMAIL_SENDER: "noreply@polinetwork.org", NODE_ENV: "test", USE_DEV_MAILER: true },
  post: vi.fn(),
  createTestAccount: vi.fn(async () => ({
    user: "u",
    pass: "p",
    smtp: { host: "localhost", port: 587, secure: false },
  })),
  sendMail: vi.fn(),
}))
vi.mock("@/env", () => ({ env }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock("@/azure/client", () => ({ getAzureClient: () => ({ api: () => ({ header: () => ({ post }) }) }) }))
// Mock the development inbox without contacting Ethereal.
vi.mock("nodemailer", () => ({
  createTestAccount,
  createTransport: () => ({ sendMail }),
  getTestMessageUrl: () => false,
}))

const props: SignedDocumentProps = {
  title: "Verbale CD 10/10/2026",
  signers: [{ name: "Mario Rossi", role: "Segretario" }],
  message: null,
  link: null,
  sentBy: { name: "Luca Verdi", email: "luca@example.org" },
}
const pdf = { filename: "verbale.pdf", content: new Uint8Array([37, 80, 68, 70]), contentType: "application/pdf" }

/** The mailer as loaded in `nodeEnv`: it picks its sender once, when it loads. */
async function mailer(nodeEnv: "test" | "development") {
  env.NODE_ENV = nodeEnv
  vi.resetModules()
  return import("@/emails/mailer")
}

/** The MIME message of the `n`th email posted to Graph. */
const mime = (n = 0) => Buffer.from(String(post.mock.calls[n]?.[0]), "base64").toString()

beforeEach(() => {
  createTestAccount.mockClear()
  post.mockReset()
  sendMail.mockReset().mockResolvedValue({})
})
afterEach(() => {
  env.NODE_ENV = "test"
})

describe("signed document mailer", () => {
  it("does not contact Ethereal when loading or sending through Graph", async () => {
    const { sendSignedDocumentEmail } = await mailer("test")
    await sendSignedDocumentEmail(["archivio@example.org"], props, null)
    expect(createTestAccount).not.toHaveBeenCalled()
  })

  it("creates the development inbox only on the first development send", async () => {
    const { sendSignedDocumentEmail } = await mailer("development")
    expect(createTestAccount).not.toHaveBeenCalled()
    await Promise.all([
      sendSignedDocumentEmail(["archivio@example.org"], props, null),
      sendSignedDocumentEmail(["archivio@example.org"], props, null),
    ])
    expect(createTestAccount).toHaveBeenCalledTimes(1)
    expect(sendMail).toHaveBeenCalledTimes(2)
  })

  it("sends it through Graph in Italian, with the PDF, replies going to the requester", async () => {
    const { sendSignedDocumentEmail } = await mailer("test")
    expect(await sendSignedDocumentEmail(["archivio@example.org"], props, pdf)).toBe(true)
    expect(mime()).toMatch(/^Subject: Documento firmato: Verbale CD 10\/10\/2026\r?$/m)
    expect(mime()).toMatch(/^Reply-To: Luca Verdi <luca@example\.org>\r?$/m)
    expect(mime()).toMatch(/filename=verbale\.pdf/)
  })

  it("sends the approved welcome through Graph with its inline header and Italian subject", async () => {
    const { sendWelcomeEmail } = await mailer("test")
    await sendWelcomeEmail(
      "ada@example.org",
      { email: "ada@polinetwork.org", password: "example-only" },
      { firstName: "Ada", assocNumber: 987 }
    )
    expect(mime()).toMatch(/^Subject: Benvenuto in PoliNetwork APS\r?$/m)
    expect(mime()).toMatch(/^Content-ID: <polinetwork-header-welcome@polinetwork\.org>\r?$/m)
    expect(mime()).toMatch(/^Content-Disposition: inline;/m)
    expect(mime()).toContain("image/png")
  })

  it("leaves replies to the sender when the requester has no address", async () => {
    const { sendSignedDocumentEmail } = await mailer("test")
    const to = ["archivio@example.org"]
    await sendSignedDocumentEmail(to, { ...props, sentBy: { name: "Luca Verdi", email: null } }, null)
    await sendSignedDocumentEmail(to, { ...props, sentBy: null }, null)
    expect(post).toHaveBeenCalledTimes(2)
    expect(mime(0)).not.toMatch(/^Reply-To:/im)
    expect(mime(1)).not.toMatch(/^Reply-To:/im)
  })

  it("sets Reply-To in development too", async () => {
    const { sendSignedDocumentEmail } = await mailer("development")
    await sendSignedDocumentEmail(["archivio@example.org"], props, pdf)
    expect(post).not.toHaveBeenCalled()
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: ["archivio@example.org"],
        subject: "[DEV] Documento firmato: Verbale CD 10/10/2026",
        replyTo: { name: "Luca Verdi", address: "luca@example.org" },
        attachments: expect.arrayContaining([
          expect.objectContaining({ filename: "verbale.pdf" }),
          expect.objectContaining({
            cid: "polinetwork-header-signed-document@polinetwork.org",
            contentDisposition: "inline",
          }),
        ]),
      })
    )
  })
})

describe("automatic fee mailer", () => {
  it.each([
    "opening",
    "reminder",
    "confirmed",
    "rejected",
  ] as const)("uses the approved %s template for the Soci outbox", async (kind) => {
    const { sendSociEmail } = await mailer("test")
    await sendSociEmail({
      id: `fee:test:${kind}`,
      memberId: 987,
      status: "pending",
      createdAt: "2099-01-01T00:00:00.000Z",
      attemptedAt: null,
      error: null,
      to: "ada@example.org",
      kind,
      data: {
        name: "Ada",
        yearLabel: "2099/2100",
        amount: "12,00 €",
        deadline: "31 dicembre 2099",
        iban: "IT60X0542811101000000123456",
        beneficiary: "PoliNetwork APS",
        reference: "Quota Ada",
        myAreaUrl: "https://example.org/me",
        reason: "Ricevuta incompleta",
      },
    })
    expect(mime()).toMatch(new RegExp(`^Content-ID: <polinetwork-header-fee-${kind}@polinetwork\\.org>\\r?$`, "m"))
    expect(mime()).toContain('class=3D"email-card"')
    expect(mime()).toMatch(/^To: ada@example\.org\r?$/m)
    expect(mime()).toMatch(/^Message-ID: <soci-[^>]+@polinetwork\.org>\r?$/m)
  })
})
