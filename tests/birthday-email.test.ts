import { render } from "@react-email/components"
import { parse } from "node-html-parser"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import BirthdayEmail, { BIRTHDAY_HEADER_URL } from "@/emails/templates/birthday"

const birthday = (name: string) => render(createElement(BirthdayEmail, { name, number: 344, since: 2024 }))

describe("birthday email presentation", () => {
  it("shows the shared artwork as a plain image, at a fixed public URL", async () => {
    const root = parse(await birthday("Mario"))
    const header = root.querySelector("img.birthday-header")
    expect(BIRTHDAY_HEADER_URL).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/PoliNetworkOrg\/backend\/[a-f0-9]{40}\/src\/emails\/assets\/birthday-header\.gif$/
    )
    expect(header?.getAttribute("src")).toBe(BIRTHDAY_HEADER_URL)
    // Classic Outlook sizes images by their attributes only.
    expect(header?.getAttribute("width")).toBe("480")
    expect(header?.getAttribute("alt")).toBe("PoliNetwork")
  })

  it("puts the greeting as escaped text on the card, never over an image or a surface of its own", async () => {
    const html = await birthday("Ada <Lovelace>")
    const root = parse(html)
    const title = root.querySelector(".birthday-title")
    expect(title?.textContent).toBe("Tanti auguri, Ada <Lovelace>!")
    expect(root.querySelector("lovelace")).toBeNull()
    // Dark mode recolours declared colours but not images: no text on artwork, no white islands, no outer tint.
    expect(html).not.toMatch(/background-image|background="|bgcolor|data:image|cid:/)
    expect(root.querySelector("body")?.getAttribute("style") ?? "").not.toContain("background")
    // The card is outlined by a border instead.
    expect(root.querySelector(".birthday-card")?.getAttribute("style")).toMatch(/border-style:solid;border-width:1px/)
  })

  it("asks the clients that listen to keep it light", async () => {
    const root = parse(await birthday("Mario"))
    expect(root.querySelector('meta[name="color-scheme"]')?.getAttribute("content")).toBe("light only")
    const styles = root.querySelectorAll("style").map((s) => s.textContent)
    expect(styles.join("\n")).toContain("color-scheme: light only")
  })

  it("shows the membership details before the message, as plain text, not in the message", async () => {
    const root = parse(await birthday("Mario"))
    const content = root.querySelector(".mail-content")
    const membership = content?.querySelector(".birthday-membership")
    const cells = membership?.querySelectorAll("td").map((td) => td.querySelectorAll("p").map((p) => p.textContent))
    expect(cells).toEqual([
      ["Socio n.", "0344"],
      ["Con noi dal", "2024"],
    ])
    expect(membership?.toString()).not.toMatch(/background/)
    const text = content?.textContent ?? ""
    expect(text.indexOf("Oggi è il tuo giorno")).toBeGreaterThan(text.indexOf("0344"))
    expect(
      content?.querySelectorAll("p").filter((p) => /0344|2024/.test(p.textContent) && p.textContent.length > 12)
    ).toEqual([])
  })
})
