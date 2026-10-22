import { beforeEach, describe, expect, it, vi } from "vitest"
import { EsignError } from "@/esign/errors"
import type { EsignService } from "@/esign/service"

vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }))

const { agentRoutes } = await import("@/esign/agent-routes")

const ticket = "a".repeat(43)
const service = { agentJob: vi.fn(), agentPrepare: vi.fn() }
const app = agentRoutes(service as unknown as EsignService)

beforeEach(() => {
  vi.clearAllMocks()
})

describe("agent routes", () => {
  it("pass the agent's User-Agent when loading a job and preparing a signature", async () => {
    service.agentJob.mockResolvedValue({ id: "job" })
    service.agentPrepare.mockResolvedValue({ toBeSigned: "AA==" })
    const userAgent = "PoliNetwork-eSign/v0.3.0"
    await app.request(`/jobs/${ticket}`, { headers: { "User-Agent": userAgent } })
    expect(service.agentJob).toHaveBeenCalledWith(ticket, userAgent)
    await app.request(`/jobs/${ticket}/prepare`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": userAgent },
      body: JSON.stringify({ certificate: "AA==", protocol: 2 }),
    })
    expect(service.agentPrepare).toHaveBeenCalledWith(ticket, "AA==", undefined, 2, userAgent)
  })

  it("answer an outdated agent with 426 and its code", async () => {
    service.agentJob.mockRejectedValue(new EsignError("agent_outdated", "PoliNetwork eSign 0.1.9 is too old."))
    const response = await app.request(`/jobs/${ticket}`, { headers: { "User-Agent": "PoliNetwork-eSign/v0.1.9" } })
    expect(response.status).toBe(426)
    expect(await response.json()).toEqual({
      error: { code: "agent_outdated", message: "PoliNetwork eSign 0.1.9 is too old." },
    })
  })
})
