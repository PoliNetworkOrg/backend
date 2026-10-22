import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { SignedDocumentProps } from "@/emails/templates/signed-document"

const { env, post, sendMail } = vi.hoisted(() => ({
  env: { AZURE_EMAIL_SENDER: "noreply@polinetwork.org", NODE_ENV: "test", USE_DEV_MAILER: true },
  post: vi.fn(),
  sendMail: vi.fn(),
}))
vi.mock("@/env", () => ({ env }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock("@/azure/client", () => ({ getAzureClient: () => ({ api: () => ({ header: () => ({ post }) }) }) }))
// The development sender's Ethereal inbox, created when the mailer loads.
vi.mock("nodemailer", () => ({
  createTestAccount: async () => ({ user: "u", pass: "p", smtp: { host: "localhost", port: 587, secure: false } }),
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
  post.mockReset()
  sendMail.mockReset().mockResolvedValue({})
})
afterEach(() => {
  env.NODE_ENV = "test"
})

describe("signed document mailer", () => {
  it("sends it through Graph in Italian, with the PDF, replies going to the requester", async () => {
    const { sendSignedDocumentEmail } = await mailer("test")
    expect(await sendSignedDocumentEmail(["archivio@example.org"], props, pdf)).toBe(true)
    expect(mime()).toMatch(/^Subject: Documento firmato: Verbale CD 10\/10\/2026\r?$/m)
    expect(mime()).toMatch(/^Reply-To: Luca Verdi <luca@example\.org>\r?$/m)
    expect(mime()).toMatch(/filename=verbale\.pdf/)
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
        attachments: [expect.objectContaining({ filename: "verbale.pdf" })],
      })
    )
  })
})
