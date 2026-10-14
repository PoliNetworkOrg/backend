import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => {
  const session = { id: Symbol("auth_sessions.id"), expiresAt: Symbol("auth_sessions.expires_at") }
  const auditLog = { id: Symbol("tg_audit_log.id") }
  const condition = Symbol("expiry-condition")
  const ended = Symbol("ended-measures")
  const returning = vi.fn(async () => [{ id: 1 }])
  const where = vi.fn(() => ({ returning }))
  const deleteFrom = vi.fn(() => ({ where }))
  const lessThan = vi.fn(() => condition)
  const endedMeasures = vi.fn(() => ended)

  return { auditLog, condition, deleteFrom, ended, endedMeasures, lessThan, returning, session, where }
})

vi.mock("croner", () => ({ Cron: vi.fn() }))
vi.mock("drizzle-orm", () => ({ lt: state.lessThan }))
vi.mock("@/db", () => ({
  DB: { delete: state.deleteFrom },
  SCHEMA: { AUTH: { session: state.session }, TG: { auditLog: state.auditLog } },
}))
vi.mock("@/env", () => ({ env: { NODE_ENV: "test" } }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock("@/utils/audit-log", () => ({ endedMeasures: state.endedMeasures }))

const { cleanAuditLog, cleanSessions } = await import("@/cron")

const DAY = 86_400_000

beforeEach(() => {
  vi.clearAllMocks()
})

describe("cleanSessions", () => {
  it("deletes sessions that expired more than 30 days ago", async () => {
    const before = Date.now()
    await cleanSessions()

    expect(state.deleteFrom).toHaveBeenCalledWith(state.session)
    expect(state.lessThan).toHaveBeenCalledWith(state.session.expiresAt, expect.any(Date))
    const cutoff = (state.lessThan.mock.calls[0] as unknown[])[1] as Date
    // setDate keeps the wall-clock time, so a DST change can shift the cutoff by an hour.
    expect(Math.abs(before - cutoff.getTime() - 30 * DAY)).toBeLessThanOrEqual(3_600_000 + 1_000)
    expect(state.where).toHaveBeenCalledWith(state.condition)
  })
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
