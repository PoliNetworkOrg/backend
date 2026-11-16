import { beforeEach, describe, expect, it, vi } from "vitest"
import type { SecretSantaEmailRequest } from "@/emails/secret-santa-routes"

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock("@/env", () => ({
  env: { NODE_ENV: "test", USE_DEV_MAILER: false, AZURE_EMAIL_SENDER: "noreply@example.test" },
}))
vi.mock("@/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@/azure/client", () => ({ getAzureClient: () => ({ api: () => ({ header: () => ({ post }) }) }) }))
const base = {
  id: "santa:person:deadline",
  name: "Ada",
  to: "ada@example.test",
  url: "https://live.example/secret-santa",
}
beforeEach(() => {
  post.mockReset().mockResolvedValue({})
})

describe("Secret Santa transactional sender", () => {
  it("sends every template through Graph with an inline logo and a stable Message-ID", async () => {
    const { sendSecretSantaEmail } = await import("@/emails/mailer")
    const messages: SecretSantaEmailRequest[] = [
      { ...base, kind: "draw", budget: "15 euro", exchange: "Cena" },
      { ...base, kind: "reassigned", withdrawnName: "Old", hasNewMatch: true, reason: "unconfirmed" },
      { ...base, kind: "confirmation-reminder", closesAt: Date.parse("2026-12-10T23:00:00Z") },
      { ...base, kind: "removed", closesAt: Date.parse("2026-12-10T23:00:00Z") },
    ]
    for (const mail of messages) await sendSecretSantaEmail(mail)
    expect(post).toHaveBeenCalledTimes(4)
    for (const [body] of post.mock.calls) {
      const mime = Buffer.from(String(body), "base64").toString()
      expect(mime).toContain("To: ada@example.test")
      expect(mime).toContain(`Message-ID: <secret-santa-${Buffer.from(base.id).toString("base64url")}@polinetwork.org>`)
      expect(mime).toContain("Content-ID: <secret-santa-logo@polinetwork.org>")
    }
  })
  it("throws provider failures so Live will keep the notification pending", async () => {
    const { sendSecretSantaEmail } = await import("@/emails/mailer")
    post.mockRejectedValue(new Error("Provider down"))
    await expect(sendSecretSantaEmail({ ...base, kind: "removed", closesAt: 123456 })).rejects.toThrow("Provider down")
  })
})
