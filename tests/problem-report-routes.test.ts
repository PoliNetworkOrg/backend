import { describe, expect, it, vi } from "vitest"
import { problemReportRoutes } from "@/emails/problem-report-routes"
import type { RequestAuth } from "@/idp/auth"

const report = {
  email: "person@example.test",
  subject: "Documento non leggibile",
  description: "Aprendo il documento dal telefono compare una pagina vuota.",
}
const authorized: RequestAuth = {
  kind: "token",
  actor: { kind: "service", client: "website" },
  scopes: new Set(["backend:public:read"]),
}
function setup(auth: RequestAuth = authorized) {
  const send = vi.fn().mockResolvedValue(undefined)
  const allow = vi.fn().mockResolvedValue(true)
  return { send, allow, app: problemReportRoutes({ authenticate: async () => auth, send, allow }) }
}
const request = (data: unknown = report) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(data),
})
describe("website problem reports", () => {
  it("sends a valid report only after authorization and rate limiting", async () => {
    const { app, send, allow } = setup()
    expect((await app.request("/", request())).status).toBe(204)
    expect(send).toHaveBeenCalledExactlyOnceWith(report)
    expect(allow).toHaveBeenCalledWith(report.email)
  })
  it("refuses unauthenticated callers and other service clients", async () => {
    for (const auth of [
      { kind: "rejected", status: 401, reason: "Missing" },
      { ...authorized, actor: { kind: "service", client: "bot" } },
      { ...authorized, scopes: new Set() },
    ] as RequestAuth[]) {
      const { app, send } = setup(auth)
      expect([401, 403]).toContain((await app.request("/", request())).status)
      expect(send).not.toHaveBeenCalled()
    }
  })
  it("rejects invalid email, header injection, small descriptions, recipient overrides and oversized bodies", async () => {
    const { app, send } = setup()
    for (const data of [
      { ...report, email: "not-email" },
      { ...report, subject: "Hello\r\nBcc: evil@example.test" },
      { ...report, description: "short" },
      { ...report, to: "evil@example.test" },
    ])
      expect((await app.request("/", request(data))).status).toBe(400)
    expect((await app.request("/", request({ ...report, description: "x".repeat(25000) }))).status).toBe(413)
    expect(send).not.toHaveBeenCalled()
  })
  it("rejects malformed JSON without sending email", async () => {
    const { app, send } = setup()
    expect(
      (await app.request("/", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status
    ).toBe(400)
    expect(send).not.toHaveBeenCalled()
  })
  it("fails closed when the rate limiter is unavailable and refuses bursts", async () => {
    const { app, send, allow } = setup()
    allow.mockResolvedValueOnce(false)
    const response = await app.request("/", request())
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe("60")
    allow.mockRejectedValueOnce(new Error("Redis down"))
    expect((await app.request("/", request())).status).toBe(503)
    expect(send).not.toHaveBeenCalled()
  })
  it("never reports success after a delivery failure", async () => {
    const { app, send } = setup()
    send.mockRejectedValueOnce(new Error("Graph down"))
    expect((await app.request("/", request())).status).toBe(502)
  })
})
