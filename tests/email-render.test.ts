import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { FEE_PREVIEW } from "@/emails/components/fee-payment"
import { renderEmail } from "@/emails/render"
import FeeOpening from "@/emails/templates/fee-opening"
import SignedDocument from "@/emails/templates/signed-document"

describe("production email rendering", () => {
  it("uses recipient data and the current fee year with one matching inline PNG", async () => {
    const rendered = await renderEmail(
      createElement(FeeOpening, {
        ...FEE_PREVIEW,
        name: "Ada <Lovelace>",
        yearLabel: "2099/2100",
        amount: "12,00 €",
        reference: "Quota Ada 987",
      })
    )
    expect(rendered.text).toContain("Ada <Lovelace>")
    expect(rendered.text).toContain("2099/2100")
    expect(rendered.text).toContain("12,00 €")
    expect(rendered.text).not.toMatch(/Mario|2026\/27/)
    expect(rendered.html).toContain("Ada &lt;Lovelace&gt;")
    expect(rendered.inlineImages).toHaveLength(1)
    const image = rendered.inlineImages[0]
    expect(rendered.html).toContain(`src="cid:${image.cid}"`)
    expect(image.content.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
    expect(image.contentDisposition).toBe("inline")
  })

  it("keeps the actual document title escaped in HTML and readable in plain text", async () => {
    const rendered = await renderEmail(
      createElement(SignedDocument, {
        title: 'Bilancio <script>alert("x")</script>',
        signers: [{ name: "Ada", role: null }],
        message: "Prima riga\nSeconda riga",
        link: null,
        sentBy: null,
      })
    )
    expect(rendered.html).toContain("Bilancio &lt;script&gt;")
    expect(rendered.html).not.toContain("<script>")
    expect(rendered.text).toContain('Bilancio <script>alert("x")</script>')
    expect(rendered.text).toContain("Prima riga\nSeconda riga")
    expect(rendered.text).not.toContain("Verbale del Consiglio")
  })
})
