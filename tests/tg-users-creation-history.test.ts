import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => {
  const users = { createdAt: Symbol("users.createdAt") }
  const rows = [
    { date: "2026-10-10", count: 3 },
    { date: "2026-10-11", count: 1 },
  ]
  const orderBy = vi.fn(async () => rows)
  const groupBy = vi.fn(() => ({ orderBy }))
  const from = vi.fn(() => ({ groupBy }))
  const select = vi.fn((_fields: unknown) => ({ from }))
  // Recorded at import, so `vi.clearAllMocks` does not reset it.
  const policies: unknown[] = []
  const error = vi.fn()

  return { error, from, groupBy, orderBy, policies, rows, select, users }
})

vi.mock("drizzle-orm", () => ({
  count: vi.fn(() => "count(*)"),
  eq: vi.fn(),
  sql: vi.fn((strings: TemplateStringsArray) => ({ sql: strings.join("?") })),
}))
vi.mock("@/db", () => ({ DB: { select: state.select }, SCHEMA: { TG: { users: state.users } } }))
vi.mock("@/logger", () => ({ logger: { error: state.error } }))
vi.mock("@/utils/db", () => ({ upsertMultipleSetSql: vi.fn() }))
vi.mock("@/utils/cipher", () => ({ DecryptError: class DecryptError extends Error {} }))
vi.mock("@/utils/users", () => ({ decryptUser: vi.fn(), encryptUser: vi.fn(), TgUserSchema: {}, userCipher: {} }))
vi.mock("@/idp/policies", () => ({
  botReadOrDashboard: vi.fn(),
  dashboard: (permission: string) => ({ user: { permission } }),
  SCOPE: { tgIngest: "tg:ingest" },
}))
vi.mock("@/trpc", () => {
  const procedure = {
    input: () => procedure,
    output: () => procedure,
    query: (handler: unknown) => ({ handler }),
    mutation: (handler: unknown) => ({ handler }),
  }
  return {
    createTRPCRouter: <T>(router: T) => router,
    policy: (rule: unknown, options: unknown = {}) => {
      state.policies.push({ rule, options })
      return procedure
    },
  }
})

const { default: usersRouter } = await import("@/routers/tg/users")
const history = usersRouter.getCreationHistory as unknown as { handler: () => Promise<unknown> }

beforeEach(() => {
  vi.clearAllMocks()
})

describe("getCreationHistory", () => {
  it("is limited to token callers who can read Telegram users", () => {
    expect(state.policies).toContainEqual({
      rule: { user: { permission: "tg:users:read" } },
      options: { tokenOnly: true },
    })
  })

  it("returns only dates and counts, grouped and ordered by creation day", async () => {
    await expect(history.handler()).resolves.toEqual({ days: state.rows, error: null })

    const fields = state.select.mock.calls[0]?.[0] as Record<string, unknown>
    expect(Object.keys(fields)).toEqual(["date", "count"])
    expect(state.from).toHaveBeenCalledWith(state.users)
    expect(state.groupBy).toHaveBeenCalledWith(fields.date)
    expect(state.orderBy).toHaveBeenCalledWith(fields.date)
  })

  it("buckets by the Europe/Rome calendar day", async () => {
    await history.handler()

    const fields = state.select.mock.calls[0]?.[0] as Record<string, { sql: string }>
    expect(fields.date.sql).toBe("to_char(? AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD')")
  })

  it("reports a database failure without throwing", async () => {
    state.orderBy.mockRejectedValueOnce(new Error("connection lost"))

    await expect(history.handler()).resolves.toEqual({ error: "INTERNAL_SERVER_ERROR" })
    expect(state.error).toHaveBeenCalled()
  })
})
