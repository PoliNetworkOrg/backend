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

function context(actor: Actor, scopes = ["backend:admin"], permissions: string[] = []): Context {
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

  it("creates and uploads documents only for regulations:manage, reading uploads from FormData", async () => {
    const router = makeRouter(
      service,
      createDirectory(async () => [{ sub: "anna", name: "Anna", email: null }])
    )
    const procedures = (router as unknown as { _def: { procedures: Record<string, { _def: { meta: unknown } }> } })._def
      .procedures
    for (const name of ["documents.create", "documents.upload", "versions.upload"])
      expect(procedures[name]._def.meta).toMatchObject({
        policy: { user: { scope: "backend:admin", permission: "regulations:manage" } },
      })
    const user: Actor = { kind: "user", sub: "anna", client: "admin-dashboard", telegramId: null }
    const form = () => {
      const fd = new FormData()
      fd.set("key", "bilancio")
      fd.set("title", "Bilancio")
      fd.set("file", new File(["%PDF-1.4"], "b.pdf", { type: "application/pdf" }))
      return fd
    }
    await expect(router.createCaller(context(user)).documents.upload(form())).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    calls.length = 0
    // The stub answers with the wrong shape (the output check refuses it): what matters is that the service was called.
    await router
      .createCaller(context(user, ["backend:admin"], ["regulations:manage"]))
      .documents.upload(form())
      .catch(() => {})
    expect(calls).toEqual(["uploadDocument:anna:Anna"])
    const missing = new FormData()
    missing.set("key", "bilancio")
    await expect(
      router.createCaller(context(user, ["backend:admin"], ["regulations:manage"])).documents.upload(missing)
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
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
        "diff.get",
        "diff.pdf",
        "diff.regenerate",
        "documents.create",
        "documents.get",
        "documents.list",
        "documents.sync",
        "documents.upload",
        "drafts.create",
        "drafts.delete",
        "drafts.files",
        "drafts.get",
        "drafts.list",
        "drafts.rename",
        "drafts.transition",
        "emanation.get",
        "emanation.retry",
        "emanation.start",
        "me.get",
        "merge.execute",
        "merge.preview",
        "snapshots.create",
        "snapshots.get",
        "snapshots.list",
        "snapshots.restore",
        "templates.list",
        "users.search",
        "versions.list",
        "versions.pdf",
        "versions.upload",
      ].sort()
    )
  })
})
