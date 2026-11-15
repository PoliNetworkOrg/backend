import type { Actor } from "@polinetwork/auth-kit"
import { beforeAll, describe, expect, it } from "vitest"
import type { Context } from "@/trpc"

Object.assign(process.env, {
  NODE_ENV: "test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "regulations_test",
})

let makeRouter: typeof import("@/regulations/router").createRegulationsRouter
let createDirectory: typeof import("@/regulations/directory").createDirectory
beforeAll(async () => {
  makeRouter = (await import("@/regulations/router")).createRegulationsRouter
  createDirectory = (await import("@/regulations/directory")).createDirectory
})

const calls: string[] = []
/** Every service method records its name and returns what `me.get` would. */
const service = new Proxy(
  {},
  {
    get: (_, name: string) => async (viewer: { sub: string; person: { name: string } }) => {
      calls.push(`${name}:${viewer.sub}:${viewer.person.name}`)
      return {
        assignedDrafts: 1,
        deleghe: 0,
        permissions: { read: false, write: false, manage: false, rectify: false },
        rectifiable: [],
      }
    },
  }
) as never

function context(actor: Actor, scopes = ["backend:admin"]): Context {
  return {
    auth: { kind: "token", actor, scopes: new Set(scopes) },
    access: {
      has: () => false,
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ fresh: true, generation: 1, subjects: 1, lastSyncAt: 1 }),
    },
  }
}

describe("regulations tRPC router", () => {
  it("lets any dashboard user in (the service checks permissions and assignments), and nobody else", async () => {
    const router = makeRouter(
      service,
      createDirectory(async () => [{ sub: "anna", name: "Anna", email: null }])
    )
    const user: Actor = { kind: "user", sub: "anna", client: "admin-dashboard", telegramId: null }
    expect(await router.createCaller(context(user)).me.get()).toMatchObject({ assignedDrafts: 1 })
    expect(calls).toEqual(["me:anna:Anna"])
    await expect(router.createCaller({}).me.get()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(router.createCaller(context({ kind: "service", client: "bot" })).me.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(router.createCaller(context(user, ["backend:public:read"])).me.get()).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("exposes the procedures of the contract shared with the admin", () => {
    const router = makeRouter(service, createDirectory(null))
    const procedures = (router as unknown as { _def: { procedures: Record<string, { _def: { meta: unknown } }> } })._def
      .procedures
    for (const proc of Object.values(procedures))
      expect(proc._def.meta).toMatchObject({ policy: { user: { scope: "backend:admin" } } })
    expect(Object.keys(procedures).sort()).toEqual(
      [
        "assignments.list",
        "assignments.remove",
        "assignments.set",
        "collabTicket",
        "comments.create",
        "comments.delete",
        "comments.list",
        "comments.reopen",
        "comments.reply",
        "comments.resolve",
        "compile.pdf",
        "compile.status",
        "deleghe.create",
        "deleghe.list",
        "deleghe.revoke",
        "documents.get",
        "documents.list",
        "documents.sync",
        "drafts.create",
        "drafts.delete",
        "drafts.files",
        "drafts.get",
        "drafts.list",
        "drafts.rename",
        "drafts.transition",
        "me.get",
        "merge.execute",
        "merge.preview",
        "snapshots.create",
        "snapshots.get",
        "snapshots.list",
        "snapshots.restore",
        "users.search",
        "versions.list",
        "versions.pdf",
      ].sort()
    )
  })
})
