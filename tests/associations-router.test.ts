import type { Actor } from "@polinetwork/auth-kit"
import { beforeAll, describe, expect, it } from "vitest"
import type { Context } from "@/trpc"
import { harness, owner, promotionHarness } from "./associations-fixture"

Object.assign(process.env, {
  NODE_ENV: "test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "test",
})
let makeRouter: typeof import("@/associations/router").createAssociationRouter
beforeAll(async () => {
  makeRouter = (await import("@/associations/router")).createAssociationRouter
})
function context(
  permissions: string[] = [],
  actor: Actor = { kind: "user", sub: owner.sub, client: "admin", telegramId: null },
  scopes = ["backend:admin"]
): Context {
  return {
    auth: { kind: "token", actor, scopes: new Set(scopes) },
    access: {
      has: (_, permission) => permissions.includes(permission),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ fresh: true, generation: 1, subjects: 1, lastSyncAt: 1 }),
    },
  }
}
describe("Association API policies", () => {
  it("rejects missing tokens, service actors and wrong audience scope", async () => {
    const router = makeRouter(harness().service)
    await expect(router.createCaller({}).list()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(
      router.createCaller(context([], { kind: "service", client: "web" }, ["backend:public:read"])).list()
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(router.createCaller(context([], undefined, ["backend:public:read"])).list()).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
  it("admits authenticated applicants without admin or People grants, scopes records and exposes no directory of personal accounts", async () => {
    const h = harness()
    const id = await h.registered()
    const router = makeRouter(h.service)
    expect((await router.createCaller(context()).get({ id })).role).toBe("responsible")
    const stranger = router.createCaller(
      context([], { kind: "user", sub: "stranger", client: "admin", telegramId: null })
    )
    await expect(stranger.get({ id })).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await stranger.directory()).toEqual([
      {
        id,
        name: "Association",
        revision: 1,
        acronym: "A",
        programmes: [],
        campuses: [],
        crossProgramme: false,
        contacts: [],
        collaboration: { open: false, contactId: null },
      },
    ])
    expect((await router.createCaller(context(["web:content:write"])).list()).operator).toBe(false)
    expect((await router.createCaller(context(["admin:access", "web:content:write"])).list()).operator).toBe(true)
  })
  it("opens the promotion queue only to operators holding both permissions", async () => {
    const h = harness()
    await h.registered()
    const router = makeRouter(h.service, undefined, promotionHarness(h).service)
    await expect(router.createCaller(context(["web:content:write"])).promotions.queue({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(await router.createCaller(context(["admin:access", "web:content:write"])).promotions.queue({})).toEqual([])
  })
})
