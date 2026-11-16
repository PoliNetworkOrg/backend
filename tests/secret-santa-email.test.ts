import { Hono } from "hono"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { renderEmail } from "@/emails/render"
import { type SecretSantaEmailRequest, secretSantaEmailRoutes } from "@/emails/secret-santa-routes"
import SecretSanta from "@/emails/templates/secret-santa"
import Confirmation from "@/emails/templates/secret-santa-confirmation"
import Reassigned from "@/emails/templates/secret-santa-reassigned"

const token = "x".repeat(32)
const url = "https://live.example/secret-santa#gift-confirmation-santa"
const request = {
  kind: "confirmation-reminder",
  id: "santa:reminder:person:date",
  to: "person@example.test",
  name: "Ada <Lovelace>",
  url,
  closesAt: Date.parse("2026-12-10T23:00:00Z"),
} as const

describe("Secret Santa mail endpoint", () => {
  it("rejects unauthenticated requests and arbitrary templates or external links", async () => {
    const send = vi.fn(async (_mail: SecretSantaEmailRequest) => {})
    const app = new Hono().route(
      "/internal/secret-santa/emails",
      secretSantaEmailRoutes({ token, publicUrl: "https://live.example", send })
    )
    const post = (body: unknown, authorization?: string) =>
      app.request("/internal/secret-santa/emails", {
        method: "POST",
        headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify(body),
      })
    expect((await post(request)).status).toBe(401)
    expect((await post(request, "Bearer wrong")).status).toBe(401)
    expect((await post({ ...request, kind: "arbitrary-html" }, `Bearer ${token}`)).status).toBe(400)
    expect((await post({ ...request, url: "https://attacker.example/secret-santa" }, `Bearer ${token}`)).status).toBe(
      400
    )
    expect((await post({ ...request, url: "https://live.example/admin" }, `Bearer ${token}`)).status).toBe(400)
    expect(send).not.toHaveBeenCalled()
    expect((await post(request, `Bearer ${token}`)).status).toBe(204)
    expect(send).toHaveBeenCalledWith(request)
  })
  it("keeps a disabled endpoint closed, limits body size, and propagates failed delivery", async () => {
    const send = vi.fn(async (_mail: SecretSantaEmailRequest) => {
      throw new Error("Provider unavailable")
    })
    const disabled = secretSantaEmailRoutes({ publicUrl: "https://live.example", send })
    expect((await disabled.request("/", { method: "POST" })).status).toBe(503)
    const app = secretSantaEmailRoutes({ token, publicUrl: "https://live.example", send })
    expect(
      (
        await app.request("/", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(request),
        })
      ).status
    ).toBe(502)
    expect((await app.request("/", { method: "POST", body: "x".repeat(13 * 1024) })).status).toBe(413)
  })
})

describe("Secret Santa email rendering", () => {
  it("describes an organizer correction without claiming that the previous recipient withdrew", async () => {
    const data = { name: "Ada", withdrawnName: "Person B", reason: "admin" as const, hasNewMatch: true, url }
    const mail = await renderEmail(createElement(Reassigned, data))
    expect(mail.text).toContain("Gli organizzatori hanno aggiornato")
    expect(mail.text).not.toContain("si è ritirato")
    expect(mail.text).not.toContain("non ha confermato")
    expect(mail.text).not.toContain("Person B")
    expect(mail.text).toContain("la tua conferma resta valida")
    const send = vi.fn(async (_mail: SecretSantaEmailRequest) => {})
    const app = secretSantaEmailRoutes({ token, publicUrl: "https://live.example", send })
    expect(
      (
        await app.request("/", {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ ...data, id: "correction", kind: "reassigned", to: "ada@example.test" }),
        })
      ).status
    ).toBe(204)
  })
  it("renders the last warning with the Italian date, escaped name, authenticated-site CTA and inline logo", async () => {
    const mail = await renderEmail(createElement(Confirmation, request))
    expect(mail.text).toContain("Ada <Lovelace>")
    expect(mail.html).toContain("Ada &lt;Lovelace&gt;")
    expect(mail.text).toContain("10 dicembre 2026")
    expect(mail.text).toContain("mezzanotte")
    expect(mail.text).toContain("Ho preso il regalo")
    expect(mail.html).toContain(url)
    expect(mail.html).toContain('src="cid:secret-santa-logo@polinetwork.org"')
    expect(mail.html).not.toContain('src="/static/')
    expect(mail.inlineImages).toHaveLength(1)
    expect(mail.inlineImages[0]?.content.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  })
  it("explains removal as a missing confirmation and reassignment without exposing a new name", async () => {
    const removed = await renderEmail(createElement(Confirmation, { ...request, kind: "removed" }))
    expect(removed.text).toContain("sei stato rimosso")
    expect(removed.text).toContain("Non hai confermato")
    expect(removed.text).not.toContain("non hai comprato")
    const reassigned = await renderEmail(
      createElement(Reassigned, {
        name: "Ada",
        withdrawnName: "Person B",
        reason: "unconfirmed",
        hasNewMatch: true,
        url,
      })
    )
    expect(reassigned.text).toContain("non ha confermato il regalo")
    expect(reassigned.text).toContain("la tua conferma resta valida")
    expect(reassigned.text).not.toContain("si è ritirato")
  })
  it("keeps the draw email's existing artwork embedded without a remote GitHub dependency", async () => {
    const mail = await renderEmail(createElement(SecretSanta, { name: "Ada", url }))
    expect(mail.inlineImages).toHaveLength(1)
    expect(mail.html).not.toContain("raw.githubusercontent.com")
  })
})

describe("Secret Santa confirmation emails", () => {
  const data = { name: "Mario", url, closesAt: Date.parse("2026-12-10T23:00:00Z") }
  it("only addresses people who still have to confirm in the reminder", async () => {
    const { text } = await renderEmail(createElement(Confirmation, { ...data, kind: "confirmation-reminder" }))
    expect(text).toContain("Ho preso il regalo")
    expect(text).toContain("10 dicembre 2026")
    expect(text).not.toContain("Se hai già confermato")
  })
  it("tells removed people why and how to reach the organizers on Telegram", async () => {
    const { html, text } = await renderEmail(createElement(Confirmation, { ...data, kind: "removed" }))
    expect(text).toContain("sei stato rimosso")
    expect(text).toContain("@bia3ia")
    expect(text).toContain("@viganogabriele")
    expect(html).toContain('href="https://t.me/bia3ia"')
    expect(html).toContain('href="https://t.me/viganogabriele"')
  })
})
