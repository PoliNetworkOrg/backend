import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => {
  const auditLog = { id: Symbol("tg_audit_log.id") }
  const auditEvents = { id: Symbol("common_audit_events.id"), createdAt: Symbol("common_audit_events.created_at") }
  const ended = Symbol("ended-measures")
  const returning = vi.fn(async () => [{ id: 1 }])
  const where = vi.fn(() => ({ returning }))
  const deleteFrom = vi.fn(() => ({ where }))
  const endedMeasures = vi.fn(() => ended)

  return { auditEvents, auditLog, deleteFrom, ended, endedMeasures, returning, where }
})

vi.mock("croner", () => ({ Cron: vi.fn() }))
vi.mock("@/db", () => ({
  DB: { delete: state.deleteFrom },
  SCHEMA: { TG: { auditLog: state.auditLog }, COMMON: { auditEvents: state.auditEvents } },
}))
vi.mock("@/env", () => ({ env: { NODE_ENV: "test" } }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock("@/utils/audit-log", () => ({ endedMeasures: state.endedMeasures }))

vi.mock("drizzle-orm", () => ({ lt: (column: unknown, value: unknown) => ({ lt: [column, value] }) }))

const { cleanAuditEvents, cleanAuditLog } = await import("@/cron")

beforeEach(() => {
  vi.clearAllMocks()
})

describe("cleanAuditLog", () => {
  it("deletes the moderation records past their retention", async () => {
    const before = Date.now()
    await cleanAuditLog()

    expect(state.endedMeasures).toHaveBeenCalledWith(expect.any(Date))
    const now = (state.endedMeasures.mock.calls[0] as unknown[])[0] as Date
    expect(now.getTime()).toBeGreaterThanOrEqual(before)
    expect(now.getTime()).toBeLessThanOrEqual(Date.now())
    expect(state.deleteFrom).toHaveBeenCalledWith(state.auditLog)
    expect(state.where).toHaveBeenCalledWith(state.ended)
  })
})

describe("cleanAuditEvents", () => {
  it("deletes the audit events written more than 24 months ago", async () => {
    await cleanAuditEvents(new Date("2026-11-08T04:23:00Z"))

    expect(state.deleteFrom).toHaveBeenCalledWith(state.auditEvents)
    expect(state.where).toHaveBeenCalledWith({ lt: [state.auditEvents.createdAt, new Date("2024-11-08T04:23:00Z")] })
  })
})
