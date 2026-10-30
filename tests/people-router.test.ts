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
  it("validates profiles before reaching People", async () => {
    const h = harness()
    await h.seed()
    const r = makeRouter(h.service)
    await expect(
      r.createCaller(context()).persons.create({ ...profile(), firstName: "X".repeat(81) })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(h.state().counters.person).toBe(3)
  })
  it("mounts every People procedure with a dashboard policy", () => {
    const r = makeRouter(harness().service)
    const procedures = (r as unknown as { _def: { procedures: Record<string, { _def: { meta: unknown } }> } })._def
      .procedures
    const defs = Object.entries(procedures)
    for (const [, proc] of defs) expect(proc._def.meta).toMatchObject({ policy: { user: { scope: "backend:admin" } } })
    expect(Object.keys(procedures).sort()).toEqual([
      "admins.end",
      "admins.setCapoOfReference",
      "admins.setCapoScope",
      "capo.get",
      "linking.invites",
      "linking.link",
      "linking.revokeInvite",
      "linking.searchAccounts",
      "linking.sendInvite",
      "linking.unlink",
      "me.acceptInvite",
      "me.get",
      "me.roles",
      "persons.create",
      "persons.get",
      "persons.list",
      "persons.setNote",
      "persons.update",
      "teams.addMember",
      "teams.candidates",
      "teams.endMembership",
      "teams.list",
      "teams.updateFields",
    ])
  })
})
