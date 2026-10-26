import type { Actor } from "@polinetwork/auth-kit"
import { beforeAll, describe, expect, it } from "vitest"
import type { Context } from "@/trpc"
import { harness, permissions, profile } from "./people-fixtures"

Object.assign(process.env, {
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "people_test",
})
let makeRouter: typeof import("@/people/router").createPeopleRouter
beforeAll(async () => {
  makeRouter = (await import("@/people/router")).createPeopleRouter
})
function context(
  granted = permissions,
  actor: Actor = { kind: "user", sub: "president", client: "admin-dashboard", telegramId: "101" },
  scopes = ["backend:admin"]
): Context {
  return {
    auth: { kind: "token", actor, scopes: new Set(scopes) },
    access: {
      has: (_, p) => granted.includes(p),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ fresh: true, generation: 1, subjects: 1, lastSyncAt: 1 }),
    },
  }
}
describe("People tRPC contract", () => {
  it("refuses tokenless, service, Telegram and wrong-scope callers before reaching People", async () => {
    const h = harness()
    const r = makeRouter(h.service)
    await expect(r.createCaller({}).me.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(
      r.createCaller(context(permissions, { kind: "service", client: "bot" })).me.get()
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      r
        .createCaller(context(permissions, { kind: "telegram", client: "bot", sub: "president", telegramId: "101" }))
        .me.get()
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      r.createCaller(context(permissions, undefined, ["backend:public:read"])).me.get()
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("validates profiles and returns only the register projection", async () => {
    const h = harness()
    await h.seed()
    const r = makeRouter(h.service)
    await expect(
      r.createCaller(context()).persons.create({ ...profile(), firstName: "X".repeat(81) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const rows = await r.createCaller(context(["admin:access", "people:members:read"])).members.list()
    expect(Object.keys(rows[0]).sort()).toEqual(["account", "id", "member", "profile"])
    expect(rows[0].profile.personalEmail).toBeNull()
  })
  it("mounts every procedure used by admin #100 with a dashboard policy", () => {
    const r = makeRouter(harness().service)
    const procedures = (r as unknown as { _def: { procedures: Record<string, { _def: { meta: unknown } }> } })._def
      .procedures
    const defs = Object.entries(procedures)
    expect(defs.length).toBe(60)
    for (const [, proc] of defs) expect(proc._def.meta).toMatchObject({ policy: { user: { scope: "backend:admin" } } })
    for (const path of [
      "persons.list",
      "members.list",
      "teams.candidates",
      "census.importPreview",
      "linking.resolve",
      "capo.get",
      "me.roles",
      "fees.review",
      "receipts.prepareSignatures",
      "receipts.sendSigned",
    ])
      expect(procedures[path]).toBeDefined()
  })
})
