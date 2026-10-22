import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => {
  const link = { createdAt: Symbol("tg_link.created_at") }
  const messages = { createdAt: Symbol("tg_messages.created_at"), timestamp: Symbol("tg_messages.timestamp") }
  const condition = Symbol("expiry-condition")
  const returning = vi.fn(async () => [])
  const where = vi.fn(() => ({ returning }))
  const deleteFrom = vi.fn(() => ({ where }))
  const lessThan = vi.fn(() => condition)

  return { condition, deleteFrom, lessThan, link, messages, returning, where }
})

vi.mock("croner", () => ({ Cron: vi.fn() }))
vi.mock("drizzle-orm", () => ({ lt: state.lessThan }))
vi.mock("@/db", () => ({
  DB: { delete: state.deleteFrom },
  SCHEMA: { TG: { link: state.link, messages: state.messages } },
}))
vi.mock("@/env", () => ({ env: { NODE_ENV: "test" } }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))

const { cleanLinkCodes } = await import("@/cron")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("cleanLinkCodes", () => {
  it("deletes link rows using the link creation timestamp", async () => {
    await cleanLinkCodes()

    expect(state.deleteFrom).toHaveBeenCalledWith(state.link)
    expect(state.lessThan).toHaveBeenCalledWith(state.link.createdAt, expect.any(Date))
    expect(state.where).toHaveBeenCalledWith(state.condition)
    expect(state.returning).toHaveBeenCalledOnce()
  })
})
