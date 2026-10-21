import { describe, expect, it } from "vitest"
import { MIN_AGENT_VERSION, outdatedAgent } from "@/esign/agent-version"

describe("agent version", () => {
  it("is 0.2.0, the first agent with protocol 2", () => {
    expect(MIN_AGENT_VERSION).toBe("0.2.0")
  })

  it("names the version of an agent older than the minimum", () => {
    expect(outdatedAgent("PoliNetwork-eSign/v0.1.9")).toBe("0.1.9")
    expect(outdatedAgent("PoliNetwork-eSign/0.1.1")).toBe("0.1.1")
    expect(outdatedAgent("PoliNetwork-eSign/v0.1.1-3-gabc1234")).toBe("0.1.1-3-gabc1234")
  })

  it("lets through the minimum and newer, suffixes counting as their release", () => {
    for (const version of ["v0.2.0", "0.2.0", "v0.2.1", "v0.3.0", "v1.0.0", "v0.10.0", "v0.2.0-rc.1", "v0.3.0+build.5"])
      expect(outdatedAgent(`PoliNetwork-eSign/${version}`)).toBeNull()
  })

  it("never refuses an agent whose version it can't read", () => {
    for (const userAgent of [
      null,
      "",
      "PoliNetwork-eSign/dev",
      "PoliNetwork-eSign/abc1234",
      "PoliNetwork-eSign/0.1",
      "PoliNetwork-eSign/0.1.9 extra",
      "PoliNetwork-Sign-Agent/0.1.0",
      "Mozilla/5.0 PoliNetwork-eSign/0.1.0",
      "node",
    ])
      expect(outdatedAgent(userAgent)).toBeNull()
  })
})
