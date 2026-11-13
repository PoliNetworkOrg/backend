import type { Actor } from "@polinetwork/auth-kit"
import { PDFDocument } from "pdf-lib"
import { beforeAll, describe, expect, it } from "vitest"
import type { Context } from "@/trpc"
import { admitInput, harness, registerInput } from "./soci-fixtures"

Object.assign(process.env, {
  NODE_ENV: "test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "soci_test",
})
let makeRouter: typeof import("@/soci/router").createSociRouter
beforeAll(async () => {
  makeRouter = (await import("@/soci/router")).createSociRouter
})

const DIRETTIVO = ["admin:access", "soci:read", "soci:write"]
const user: Actor = { kind: "user", sub: "usr_direttivo", client: "admin-dashboard", telegramId: null }

function context(granted = DIRETTIVO, actor: Actor = user, scopes = ["backend:admin"]): Context {
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

describe("Soci tRPC contract", () => {
  it("gives every procedure a dashboard policy with its soci permission", () => {
    const r = makeRouter(harness().service)
    const procedures = (r as unknown as { _def: { procedures: Record<string, { _def: { meta: unknown } }> } })._def
      .procedures
    expect(Object.fromEntries(Object.entries(procedures).map(([path, p]) => [path, p._def.meta]))).toEqual({
      "members.list": { policy: { user: { scope: "backend:admin", permission: "soci:read" } } },
      "members.get": { policy: { user: { scope: "backend:admin", permission: "soci:read" } } },
      "members.unregistered": { policy: { user: { scope: "backend:admin", permission: "soci:read" } } },
      "members.admit": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "members.register": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "members.update": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "members.setNumber": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "fees.list": { policy: { user: { scope: "backend:admin", permission: "soci:read" } } },
      "fees.file": { policy: { user: { scope: "backend:admin", permission: "soci:read" } } },
      "fees.confirm": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "fees.reject": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "fees.markPaid": { policy: { user: { scope: "backend:admin", permission: "soci:write" } } },
      "me.get": { policy: { user: { scope: "backend:admin", permission: "people:self" } } },
      "me.uploadReceipt": { policy: { user: { scope: "backend:admin", permission: "people:self" } } },
      "me.completeDetails": { policy: { user: { scope: "backend:admin", permission: "people:self" } } },
    })
  })

  it("needs admin:access as well as the soci permission", async () => {
    const r = makeRouter(harness().service)
    await expect(r.createCaller({}).members.list()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    await expect(r.createCaller(context(["soci:read", "soci:write"])).members.list()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Missing admin:access",
    })
    await expect(
      r.createCaller(context(["admin:access", "soci:read"])).members.admit(admitInput())
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      r.createCaller(context(DIRETTIVO, { kind: "service", client: "bot" })).members.list()
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(await r.createCaller(context(["admin:access", "soci:read"])).members.list()).toEqual({
      members: [],
      directoryAvailable: true,
    })
  })

  it("validates the codice fiscale before reaching Microsoft 365, and takes the author from the token", async () => {
    const h = harness()
    const caller = makeRouter(h.service).createCaller(context())
    const input = admitInput()
    await expect(
      caller.members.admit({ ...input, details: { ...input.details, codiceFiscale: "RSSMRA80A01H501X" } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(await h.directory.findByMail("mario.rossi@polinetwork.org")).toBeNull()

    await caller.members.admit(input)
    expect((await caller.members.get({ number: 344 })).createdBy).toBe("usr_direttivo")
  })

  it("finds the socio of me.* by the account's Microsoft 365 object ID, and refuses anyone else", async () => {
    const h = harness()
    await h.service.register("usr_direttivo", registerInput("mock-member-alan"))
    await h.service.runDaily()
    const soci = makeRouter(h.service)
    const signedIn = (entraObjectId: string | null, granted = ["people:self"]) => {
      const ctx = context(granted, { ...user, sub: "usr_socio" })
      return soci.createCaller({
        ...ctx,
        access: { ...ctx.access, current: () => ({ bySub: () => ({ entraObjectId }) }) as never },
      } as Context)
    }

    expect((await signedIn("mock-member-alan").me.get()).number).toBe(1002)
    await expect(signedIn("mock-member-alan", ["admin:access"]).me.get()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(signedIn(null).me.get()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(signedIn("mock-member-grace").me.get()).rejects.toMatchObject({ code: "NOT_FOUND" })

    const doc = await PDFDocument.create()
    doc.addPage([100, 100])
    const form = (file: Blob, declaredCents = "500") => {
      const fd = new FormData()
      fd.set("file", file, "bonifico.pdf")
      fd.set("transferDate", "2026-11-09")
      fd.set("declaredCents", declaredCents)
      return fd
    }
    const pdf = new Blob([new Uint8Array(await doc.save())], { type: "application/pdf" })
    await expect(signedIn("mock-member-alan").me.uploadReceipt(form(pdf, "zero"))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(
      signedIn("mock-member-alan").me.uploadReceipt(form(new Blob([new Uint8Array(10 * 1024 * 1024 + 1)])))
    ).rejects.toThrow(/larger than 10 MB/)
    await signedIn("mock-member-alan").me.uploadReceipt(form(pdf))
    expect((await signedIn("mock-member-alan").me.get()).fees[0]).toMatchObject({
      status: "uploaded",
      upload: { fileName: "bonifico.pdf", declaredCents: 500 },
    })
    expect((await h.service.get({ number: 1002 })).activity[0].actor).toBe("usr_socio")
  })
})
