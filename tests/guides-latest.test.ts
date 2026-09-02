import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => {
  const guides = { date: Symbol("guides.date") }
  const latest = { id: 7, version: "2026", date: "2026-09-02", file: "https://example.test/guide.pdf" }
  const limit = vi.fn(async () => [latest])
  const orderBy = vi.fn(() => ({ limit }))
  const from = vi.fn(() => ({ orderBy }))
  const select = vi.fn(() => ({ from }))

  return { from, guides, latest, limit, orderBy, select }
})

vi.mock("drizzle-orm", () => ({ desc: vi.fn((column: unknown) => column), eq: vi.fn() }))
vi.mock("@/azure/blob", () => ({ deleteBlob: vi.fn(), uploadBlob: vi.fn() }))
vi.mock("@/db", () => ({ DB: { select: state.select }, SCHEMA: { WEB: { guidesMatricole: state.guides } } }))
vi.mock("@/trpc", () => ({
  createTRPCRouter: <T>(router: T) => router,
  publicProcedure: {
    input: () => ({ mutation: (handler: unknown) => ({ handler }) }),
    output: () => ({ query: (handler: () => unknown) => ({ handler }) }),
  },
}))

const { default: guidesRouter } = await import("@/routers/web/guides_matricole")
const latestGuide = guidesRouter.getLatestGuide as unknown as { handler: () => Promise<unknown> }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getLatestGuide", () => {
  it("returns the newest guide without printing query results", async () => {
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {})

    await expect(latestGuide.handler()).resolves.toEqual(state.latest)
    expect(consoleLog).not.toHaveBeenCalled()
    expect(state.from).toHaveBeenCalledWith(state.guides)
    expect(state.limit).toHaveBeenCalledWith(1)

    consoleLog.mockRestore()
  })
})
