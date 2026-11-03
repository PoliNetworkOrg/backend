import type { Actor } from "@polinetwork/auth-kit"
import { beforeAll, describe, expect, it } from "vitest"
import type { Context } from "@/trpc"
import { harness, master, permissions, profile } from "./people-fixtures"

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
    expect(Object.keys(h.state().persons)).toHaveLength(3)
  })
  it("lets a signed-in account without People permissions open and accept an invite", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.sendInvite(master, { personId: "P-0003" })
    const token = Object.values(h.state().mail)[0].text.match(/invite\?token=([A-Za-z0-9_-]{43})/)?.[1] ?? ""
    const actor: Actor = { kind: "user", sub: "newcomer", client: "admin-dashboard", telegramId: null }
    const caller = makeRouter(h.service).createCaller(context([], actor))
    await expect(caller.me.get()).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await caller.me.invite({ token })).toMatchObject({ name: "Luca Verdi" })
    await caller.me.acceptInvite({ token })
    expect(h.state().persons["P-0003"].accountSub).toBe("newcomer")
  })
  it("mounts every People procedure with a dashboard policy", () => {
    const r = makeRouter(harness().service)
    const procedures = (r as unknown as { _def: { procedures: Record<string, { _def: { meta: unknown } }> } })._def
      .procedures
    const defs = Object.entries(procedures)
    for (const [, proc] of defs) expect(proc._def.meta).toMatchObject({ policy: { user: { scope: "backend:admin" } } })
    expect(Object.keys(procedures).sort()).toEqual([
      "admins.assign",
      "admins.end",
      "admins.list",
      "admins.setCapoOfReference",
      "capo.get",
      "capos.appoint",
      "capos.end",
      "capos.list",
      "capos.setScope",
      "linking.invites",
      "linking.link",
      "linking.recent",
      "linking.revokeInvite",
      "linking.searchAccounts",
      "linking.sendInvite",
      "linking.unlink",
      "me.acceptInvite",
      "me.get",
      "me.invite",
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
