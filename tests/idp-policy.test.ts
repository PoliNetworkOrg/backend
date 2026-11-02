import type { Actor } from "@polinetwork/auth-kit"
import { describe, expect, it, vi } from "vitest"
import type { RequestAuth } from "@/idp/auth"

// "@/trpc" loads the logger, which validates the environment on import.
vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DB_HOST: "localhost",
    DB_USER: "postgres",
    DB_PASS: "postgres",
  })
})

import { type Context, createTRPCRouter, policy } from "@/trpc"

const router = createTRPCRouter({
  lookup: policy({
    service: { scope: "backend:tg:read" },
    telegram: { scope: "backend:tg:read", permission: "tg:audit:read" },
    user: { scope: "backend:admin", permission: "tg:audit:read" },
  }).query(({ ctx }) => ({ actor: ctx.actor })),
  dashboardOnly: policy({ user: { scope: "backend:admin", permission: "admin:access" } }).query(() => "ok"),
  multiScope: policy({ service: { scope: ["backend:tg:read", "backend:public:read"] } }).query(() => "ok"),
})

const bot: Actor = { kind: "service", client: "telegram-bot" }
const moderator: Actor = { kind: "telegram", client: "telegram-bot", telegramId: "123", sub: "usr_mod" }
const admin: Actor = { kind: "user", client: "admin-dashboard", sub: "usr_admin", telegramId: null }

function caller(auth: RequestAuth, permissions: string[] = []) {
  const ctx: Context = {
    auth,
    access: {
      has: (actor, permission) => actor.kind !== "service" && actor.sub !== null && permissions.includes(permission),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ lastSyncAt: null, fresh: false, generation: null, subjects: 0 }),
    },
  }
  return router.createCaller(ctx)
}

const token = (actor: Actor, scopes: string[]): RequestAuth => ({ kind: "token", actor, scopes: new Set(scopes) })
const code = (promise: Promise<unknown>) =>
  promise.then(
    () => "OK",
    (error: { code?: string }) => error.code
  )

describe("policy", () => {
  it("refuses a direct caller without a token", async () => {
    expect(await code(router.createCaller({}).lookup())).toBe("UNAUTHORIZED")
  })

  it("passes on authentication rejections", async () => {
    expect(await code(caller({ kind: "rejected", status: 401, reason: "bad" }).lookup())).toBe("UNAUTHORIZED")
    expect(await code(caller({ kind: "rejected", status: 403, reason: "actor" }).lookup())).toBe("FORBIDDEN")
    expect(await code(caller({ kind: "rejected", status: 503, reason: "keys" }).lookup())).toBe("SERVICE_UNAVAILABLE")
  })

  it("authorizes services by scope alone and hands the actor to the handler", async () => {
    expect(await caller(token(bot, ["backend:tg:read"])).lookup()).toEqual({ actor: bot })
    expect(await code(caller(token(bot, ["backend:tg:ingest"])).lookup())).toBe("FORBIDDEN")
    expect(await caller(token(bot, ["backend:public:read"])).multiScope()).toBe("ok")
  })

  it("requires both the scope and the person's permission", async () => {
    expect(await caller(token(moderator, ["backend:tg:read"]), ["tg:audit:read"]).lookup()).toEqual({
      actor: moderator,
    })
    expect(await code(caller(token(moderator, ["backend:tg:read"]), []).lookup())).toBe("FORBIDDEN")
    expect(await code(caller(token(moderator, ["backend:admin"]), ["tg:audit:read"]).lookup())).toBe("FORBIDDEN")
    expect(
      await code(caller(token({ ...moderator, sub: null }, ["backend:tg:read"]), ["tg:audit:read"]).lookup())
    ).toBe("FORBIDDEN")
    expect(await caller(token(admin, ["backend:admin"]), ["admin:access"]).dashboardOnly()).toBe("ok")
  })

  it("denies actor kinds a procedure does not list", async () => {
    expect(await code(caller(token(bot, ["backend:admin"])).dashboardOnly())).toBe("FORBIDDEN")
    expect(await code(caller(token(moderator, ["backend:admin"]), ["admin:access"]).dashboardOnly())).toBe("FORBIDDEN")
  })
})
