import { render, toPlainText } from "@react-email/components"
import { parse } from "node-html-parser"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import { FEE_PREVIEW } from "@/emails/components/fee-payment"
import FeeRejected from "@/emails/templates/fee-rejected"
import RequestUpdate from "@/emails/templates/request-update"
import SignedDocument from "@/emails/templates/signed-document"
import Welcome from "@/emails/templates/welcome"

const templates = [
  "welcome",
  "member-number-changed",
  "fee-opening",
  "fee-reminder",
  "fee-confirmed",
  "fee-rejected",
  "signature-request",
  "request-update",
  "signed-document",
]

describe("email client presentation", () => {
  it.each(templates)("%s uses the approved Italian card, inline header and valid table rows", async (name) => {
    const { default: Template } = await import(`../src/emails/templates/${name}.tsx`)
    const html = await render(createElement(Template, Template.PreviewProps))
    const root = parse(html)
    const logo = root.querySelector("img")
    expect(root.querySelector("html")?.getAttribute("lang")).toBe("it")
    expect(root.querySelector(".email-card")).not.toBeNull()
    expect(root.querySelector(".email-frame > tbody > tr > td")?.getAttribute("style")).toContain("padding:32px 0")
    expect(logo?.getAttribute("src")).toMatch(/^cid:polinetwork-header-[a-z-]+@polinetwork\.org$/)
    expect(logo?.getAttribute("width")).toBe("518")
    expect(html).not.toMatch(
      /Welcome|Congratulations|Your member|Your signature|Open the request|This is an automated|Lorenzo Corallo|lorenzocorallo/
    )
    expect(html).not.toContain("data:image")
    const invalid = root
      .querySelectorAll("tr")
      .flatMap((row) =>
        row.childNodes.filter(
          (node) => node.nodeType === 1 && !["td", "th"].includes((node as { rawTagName?: string }).rawTagName ?? "")
        )
      )
    expect(invalid).toEqual([])
  })

  it("keeps each welcome credential once and permits long addresses to wrap", async () => {
    const email = "maria.francesca.rossibianchi@polinetwork.org"
    const html = await render(
      createElement(Welcome, { firstName: "Mario", assocNum: 344, password: "example-only", email })
    )
    expect(html.split(email)).toHaveLength(2)
    expect(parse(html).querySelector(".account-email")?.getAttribute("style")).toContain("word-break:break-all")
  })

  it("retains paragraphs in free-form messages and reasons in the plain text alternative", async () => {
    const message = "Prima riga\nSeconda riga"
    const examples = [
      createElement(SignedDocument, { title: "Verbale", signers: [], link: null, sentBy: null, message }),
      createElement(RequestUpdate, {
        recipientName: "Mario",
        title: "Verbale",
        url: "https://example.org/request",
        by: "Anna",
        outcome: "declined",
        reason: message,
      }),
      createElement(FeeRejected, { ...FEE_PREVIEW, reason: message }),
    ]
    for (const example of examples) expect(toPlainText(await render(example))).toContain(message)
  })
})
