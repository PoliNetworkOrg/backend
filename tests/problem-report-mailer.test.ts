import { beforeEach, expect, it, vi } from "vitest"

const { post } = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock("@/env", () => ({
  env: { NODE_ENV: "test", USE_DEV_MAILER: false, AZURE_EMAIL_SENDER: "noreply@polinetwork.org" },
}))
vi.mock("@/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }))
vi.mock("@/azure/client", () => ({ getAzureClient: () => ({ api: () => ({ header: () => ({ post }) }) }) }))
beforeEach(() => post.mockReset().mockResolvedValue({}))
it("uses the organization's sender, fixed IT recipient and reporter Reply-To", async () => {
  const { sendProblemReportEmail } = await import("@/emails/mailer")
  await sendProblemReportEmail({
    email: "person@example.test",
    subject: "Broken page",
    description: "<script>alert(1)</script> This page does not load.",
  })
  const mime = Buffer.from(String(post.mock.calls[0]?.[0]), "base64").toString()
  expect(mime).toContain("From: PoliNetwork APS <noreply@polinetwork.org>")
  expect(mime).toContain("To: it@polinetwork.org")
  expect(mime).toContain('Reply-To: "person@example.test" <person@example.test>')
  const html = mime.split("Content-Type: text/html")[1]
  expect(html).toBeDefined()
  expect(html).toContain("&lt;script&gt;")
  expect(html).not.toContain("<script>")
})
it("propagates Graph errors", async () => {
  const { sendProblemReportEmail } = await import("@/emails/mailer")
  post.mockRejectedValueOnce(new Error("Graph unavailable"))
  await expect(
    sendProblemReportEmail({
      email: "person@example.test",
      subject: "Broken page",
      description: "This page does not load.",
    })
  ).rejects.toThrow("Graph unavailable")
})
