import { render } from "@react-email/components"
import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import RequestUpdateEmail, { requestUpdateSubject } from "@/emails/templates/request-update"
import SignedDocumentEmail, { type SignedDocumentProps } from "@/emails/templates/signed-document"
import type { RequestUpdate } from "@/esign/service"

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

describe("request update email", () => {
  const base = {
    recipientName: "Luca",
    title: "Verbale CD",
    url: "https://admin.example.org/dashboard/esign/requests/1",
  }
  const update = async (props: RequestUpdate) => ({
    subject: requestUpdateSubject(props),
    body: (await render(createElement(RequestUpdateEmail, props), { plainText: true })).replace(/\s+/g, " "),
  })

  it("quotes who declined and why", async () => {
    const { subject, body } = await update({
      ...base,
      outcome: "declined",
      by: "Anna Bianchi",
      reason: "Data sbagliata",
    })
    expect(subject).toBe("Declined: Verbale CD")
    expect(body).toContain("Hi Luca, Anna Bianchi declined to sign Verbale CD. “Data sbagliata”")
    expect(body).toContain("Open the request https://admin.example.org/dashboard/esign/requests/1")
  })

  it("says where the signed PDF went", async () => {
    const { subject, body } = await update({
      ...base,
      outcome: "completed",
      savedTo: { path: "Verbali/Verbale CD.pdf", url: null },
      emailedTo: ["archivio@example.org"],
    })
    expect(subject).toBe("Signed by everyone: Verbale CD")
    expect(body).toContain(
      "Everyone signed Verbale CD. The signed PDF is saved in Verbali/Verbale CD.pdf and was emailed to archivio@example.org."
    )
  })

  it("says what failed, whose request it is and who can retry", async () => {
    const { subject, body } = await update({
      ...base,
      outcome: "delivery_failed",
      failed: { step: "email", target: "archivio@example.org" },
      error: "The email could not be sent",
      requestedBy: "Mario Rossi",
      canRetry: true,
    })
    expect(subject).toBe("Not delivered: Verbale CD")
    expect(body).toContain(
      "Everyone signed Mario Rossi’s request Verbale CD, but the signed PDF couldn’t be emailed to archivio@example.org. You can retry it from the request. Error: The email could not be sent"
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
