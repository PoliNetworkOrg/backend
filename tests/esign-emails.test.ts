import { render } from "@react-email/components"
import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SignedDocumentEmail, { type SignedDocumentProps } from "@/emails/templates/signed-document"

const post = vi.fn()
vi.mock("@/env", () => ({ env: { AZURE_EMAIL_SENDER: "noreply@polinetwork.org", NODE_ENV: "test" } }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock("@/azure/client", () => ({ getAzureClient: () => ({ api: () => ({ header: () => ({ post }) }) }) }))

const { sendEmail } = await import("@/azure/functions/emails")

const signed: SignedDocumentProps = {
  title: "Verbale CD 10/10/2026",
  signers: [
    { name: "Mario Rossi", role: "Segretario" },
    { name: "Anna Bianchi", role: null },
  ],
  message: "Buongiorno, vi inoltro il verbale.",
  link: null,
  sentBy: { name: "Luca Verdi", email: "luca@example.org" },
}

/** The email's text, on one line. */
async function text(props: SignedDocumentProps) {
  return (await render(createElement(SignedDocumentEmail, props), { plainText: true })).replace(/\s+/g, " ")
}

beforeEach(() => {
  post.mockReset()
})

describe("signed document email", () => {
  it("is in Italian, names the signers once and who sent it", async () => {
    const body = await text(signed)
    expect(body).toContain(
      "Buongiorno, vi inoltro il verbale. Il documento è stato firmato elettronicamente con la Carta d’Identità Elettronica (CIE) da: • Mario Rossi, Segretario • Anna Bianchi "
    )
    expect(body).toContain(
      "Inviato da Luca Verdi tramite PoliNetwork. Rispondi a questa email per scrivere a Luca Verdi."
    )
    expect(body).not.toContain("allegato")
    expect(body).not.toMatch(/do not reply/i)
  })

  it("says the document is attached when the requester wrote nothing", async () => {
    expect(await text({ ...signed, message: null })).toContain(
      "Il documento firmato è in allegato. È stato firmato elettronicamente con la Carta d’Identità Elettronica (CIE) da:"
    )
  })

  it("links a document too large to attach, whatever the requester wrote", async () => {
    const link = "https://polinetwork.sharepoint.com/verbale.pdf"
    const html = await render(createElement(SignedDocumentEmail, { ...signed, link }))
    expect(html).toContain(`href="${link}"`)
    expect(await text({ ...signed, link })).toContain(
      "Il documento firmato è troppo grande per essere allegato: aprilo su OneDrive"
    )
  })

  it("asks not to reply when nobody would read the answer", async () => {
    expect(await text({ ...signed, sentBy: { name: "Luca Verdi", email: null } })).toContain(
      "Inviato da Luca Verdi tramite PoliNetwork. Non rispondere a questa email."
    )
    expect(await text({ ...signed, sentBy: null })).toContain(
      "Inviato tramite PoliNetwork. Non rispondere a questa email."
    )
  })
})

describe("sendEmail", () => {
  const mime = () => Buffer.from(String(post.mock.calls[0]?.[0]), "base64").toString()

  it("sets Reply-To when asked", async () => {
    await sendEmail(["archivio@example.org"], "Documento firmato", createElement(SignedDocumentEmail, signed), [], {
      replyTo: { name: "Luca Verdi", address: "luca@example.org" },
    })
    expect(mime()).toMatch(/^Reply-To: Luca Verdi <luca@example\.org>\r?$/m)
  })

  it("leaves replies to the sender otherwise", async () => {
    await sendEmail("archivio@example.org", "Documento firmato", createElement(SignedDocumentEmail, signed))
    expect(mime()).not.toMatch(/^Reply-To:/im)
  })
})
