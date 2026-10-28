import { render } from "@react-email/components"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import PeopleEmail, { type PeopleEmailProps } from "@/emails/templates/people"
import { harness, master } from "./people-fixtures"

/** The email's text, on one line. */
async function text(props: PeopleEmailProps) {
  return (await render(createElement(PeopleEmail, props), { plainText: true })).replace(/\s+/g, " ")
}

describe("People emails", () => {
  it("greets the recipient, explains, and offers the link as a button and as text", async () => {
    const body = await text({
      subject: "PoliNetwork · collega il tuo account",
      firstName: "Luca",
      text: "Primo paragrafo.\n\nSecondo paragrafo.",
      action: { label: "Collega il tuo account", url: "https://example.org/x" },
    })
    expect(body).toContain("Ciao Luca,")
    expect(body).toContain("Primo paragrafo. Secondo paragrafo.")
    expect(body).toContain("Collega il tuo account")
    expect(body).toContain("Se il pulsante non funziona, copia questo indirizzo nel browser")
    expect(body).toContain("non rispondere a questa email")
  })

  it("sends an invitation that says who invites, why, how and until when", async () => {
    const h = harness()
    await h.seed()
    await h.service.unlinkAccount(master, { personId: "P-0003" })
    await h.service.sendInvite(master, { personId: "P-0003" })
    await h.service.deliverPending()
    const [mail] = h.sendMail.mock.calls.at(-1) ?? []
    expect(mail).toMatchObject({
      to: "luca@example.org",
      subject: "PoliNetwork · collega il tuo account",
      firstName: "Luca",
      action: { label: "Collega il tuo account", url: expect.stringContaining("peopleInvite=") },
    })
    expect(mail?.text).toContain("il team HR di PoliNetwork ti invita")
    expect(mail?.text).toContain("luca@example.org")
    expect(mail?.text).toMatch(/Scadenza dell'invito: \d{1,2} \w+ \d{4}\./)
    expect(mail?.text).not.toContain("peopleInvite=")
  })
})
