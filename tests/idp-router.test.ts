import type { Actor } from "@polinetwork/auth-kit"
import { beforeAll, describe, expect, it, vi } from "vitest"
import type { Context } from "@/trpc"

const REQUIRED_ENV: Record<string, string> = {
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "polinetwork_backend_test",
}
for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value

const db = vi.hoisted(() => ({ grants: [] as Array<{ userId: number; validUntil: Date }> }))

// The real schema, without a connection: importing "@/db" would run migrations.
vi.mock("@/db", async () => {
  const [auth, common, tg, wa, web, views] = await Promise.all([
    import("@/db/schema/auth"),
    import("@/db/schema/common"),
    import("@/db/schema/tg"),
    import("@/db/schema/wa"),
    import("@/db/schema/web"),
    import("@/db/schema/views"),
  ])
  const query = { from: () => query, where: async () => db.grants }
  return {
    DB: { select: () => query },
    SCHEMA: { AUTH: auth.schema, COMMON: common.schema, TG: tg.schema, WA: wa.schema, WEB: web.schema },
    VIEWS: { GROUPS: views.views },
  }
})
vi.mock("@/server", () => ({ WSS: {} }))

let appRouter: typeof import("@/routers").appRouter

beforeAll(async () => {
  ;({ appRouter } = await import("@/routers"))
})

type ProcedureDef = { _def: { meta?: { policy?: unknown } } }

function procedures(): Array<[string, ProcedureDef]> {
  return Object.entries(
    (appRouter as unknown as { _def: { procedures: Record<string, ProcedureDef> } })._def.procedures
  )
}

describe("app router", () => {
  it("gives every procedure a policy", () => {
    const missing = procedures()
      .filter(([, procedure]) => !procedure._def.meta?.policy)
      .map(([path]) => path)
    expect(procedures().length).toBeGreaterThan(90)
    expect(missing).toEqual([])
  })

  it("keeps procedures that RFC v3 removes on the legacy path only", () => {
    const legacy = new Set(
      procedures()
        .filter(([, procedure]) => procedure._def.meta?.policy === "legacy")
        .map(([path]) => path)
    )
    for (const path of [
      "auth.updateProfilePic",
      "test.dbQuery",
      "tg.permissions.addRole",
      "tg.link.link",
      "azure.groups.addMember",
      "azure.members.getAll",
    ])
      expect(legacy).toContain(path)
  })

  it("refuses the removed tg.groupLabels mount to token callers", async () => {
    const admin: Actor = { kind: "user", client: "admin-dashboard", sub: "usr_admin", telegramId: null }
    const ctx: Context = {
      auth: { kind: "token", actor: admin, scopes: new Set(["backend:admin"]) },
      access: {
        has: () => true,
        current: () => null,
        subjectBySub: () => undefined,
        subjectByTelegramId: () => undefined,
        status: () => ({ lastSyncAt: 1, fresh: true, generation: 1, subjects: 1 }),
      },
    }
    await expect(appRouter.createCaller(ctx).tg.groupLabels.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("tg.access.resolve and me.access", () => {
  const index = {
    permissions: (subject: { sub: string }) => (subject.sub === "usr_mod" ? ["tg:moderate"] : []),
  }
  const access = (fresh: boolean): NonNullable<Context["access"]> => ({
    has: () => fresh,
    current: () => index as never,
    subjectBySub: (sub) => (fresh && sub === "usr_mod" ? ({ sub, telegramId: "123" } as never) : undefined),
    subjectByTelegramId: (id) =>
      fresh && String(id) === "123" ? ({ sub: "usr_mod", telegramId: "123" } as never) : undefined,
    status: () => ({ lastSyncAt: 1, fresh, generation: 1, subjects: 1 }),
  })
  const bot: Actor = { kind: "service", client: "telegram-bot" }

  it("resolves Telegram users to their subject, permissions and active grant", async () => {
    const validUntil = new Date(Date.now() + 3_600_000)
    db.grants = [{ userId: 456, validUntil }]
    const caller = appRouter.createCaller({
      auth: { kind: "token", actor: bot, scopes: new Set(["backend:tg:read"]) },
      access: access(true),
    })
    expect(await caller.tg.access.resolve({ telegramIds: [123, "456", "123"] })).toEqual({
      "123": { sub: "usr_mod", permissions: ["tg:moderate"], grant: null },
      "456": { sub: null, permissions: [], grant: { validUntil } },
    })
  })

  it("rejects IDs outside the safe-integer range as bad input", async () => {
    const caller = appRouter.createCaller({
      auth: { kind: "token", actor: bot, scopes: new Set(["backend:tg:read"]) },
      access: access(true),
    })
    await expect(caller.tg.access.resolve({ telegramIds: ["99999999999999999999"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  it("returns no permissions from a stale snapshot", async () => {
    db.grants = []
    const caller = appRouter.createCaller({
      auth: { kind: "token", actor: bot, scopes: new Set(["backend:tg:read"]) },
      access: access(false),
    })
    expect(await caller.tg.access.resolve({ telegramIds: ["123"] })).toEqual({
      "123": { sub: null, permissions: [], grant: null },
    })
  })

  it("refuses anonymous callers on the new procedures", async () => {
    const caller = appRouter.createCaller({})
    await expect(caller.tg.access.resolve({ telegramIds: ["123"] })).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(caller.me.access()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })

  it("tells a dashboard user their own permissions", async () => {
    const user: Actor = { kind: "user", client: "admin-dashboard", sub: "usr_mod", telegramId: "123" }
    const caller = appRouter.createCaller({
      auth: { kind: "token", actor: user, scopes: new Set(["backend:admin"]) },
      access: access(true),
    })
    expect(await caller.me.access()).toEqual({
      sub: "usr_mod",
      telegramId: "123",
      permissions: ["tg:moderate"],
      stale: false,
    })
  })
})
