import type { Actor } from "@polinetwork/auth-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { freshmanSlots } from "@/routers/web/freshman/constants"
import {
  moveFreshmanCardInput,
  selectFreshmanFaqInput,
  updateFreshmanCardInput,
} from "@/routers/web/freshman/validation"
import type { Context } from "@/trpc"

vi.hoisted(() => {
  Object.assign(process.env, {
    NODE_ENV: "test",
    BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    DB_HOST: "localhost",
    DB_USER: "postgres",
    DB_PASS: "postgres",
  })
})

const db = vi.hoisted(() => ({ transaction: vi.fn(), set: vi.fn(), update: vi.fn() }))
vi.mock("@/db", async () => ({
  DB: { transaction: db.transaction, update: db.update },
  SCHEMA: { WEB: (await import("@/db/schema/web")).schema },
}))

import freshman from "@/routers/web/freshman"

const fields = { title: "Title", description: "Description", icon: "book" as const, href: "/materials" }
const editor: Actor = { kind: "user", sub: "editor", client: "admin", telegramId: null }
const service: Actor = { kind: "service", client: "website" }

function context(actor: Actor, permissions: string[], scopes = ["backend:admin"], fresh = true): Context {
  return {
    auth: { kind: "token", actor, scopes: new Set(scopes) },
    access: {
      has: (_, permission) => fresh && permissions.includes(permission),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ lastSyncAt: 1, fresh, generation: 1, subjects: 1 }),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  const chain = { where: () => ({ returning: async () => [{ id: "featured-1" }] }) }
  db.set.mockReturnValue(chain)
  db.update.mockReturnValue({ set: db.set })
})

describe("Freshman validation", () => {
  it("accepts only fixed slots, safe destinations, bounded content and known icons", () => {
    expect(freshmanSlots).toHaveLength(18)
    expect(updateFreshmanCardInput.parse({ id: "featured-1", ...fields }).href).toBe("/materials")
    for (const href of [
      "javascript:alert(1)",
      "data:text/html,test",
      "//evil.example",
      "/\\evil.example",
      "https://user:secret@example.org",
    ]) {
      expect(updateFreshmanCardInput.safeParse({ id: "featured-1", ...fields, href }).success).toBe(false)
    }
    for (const invalid of [
      { id: "new-slot" },
      { title: " " },
      { title: "x".repeat(121) },
      { description: "x".repeat(1001) },
      { icon: "arbitrary" },
      { group: "tools" },
    ]) {
      expect(updateFreshmanCardInput.safeParse({ id: "featured-1", ...fields, ...invalid }).success).toBe(false)
    }
    expect(updateFreshmanCardInput.safeParse({ id: "telegram-1", ...fields, href: "" }).success).toBe(false)
    expect(updateFreshmanCardInput.safeParse({ id: "guides-2", ...fields, href: "" }).success).toBe(true)
  })

  it("requires an adjacent move and one of the five FAQ positions", () => {
    for (const direction of [0, 2, -2, 0.5])
      expect(moveFreshmanCardInput.safeParse({ id: "featured-1", direction }).success).toBe(false)
    for (const position of [-1, 5, 0.5])
      expect(selectFreshmanFaqInput.safeParse({ position, faqId: 1 }).success).toBe(false)
    expect(selectFreshmanFaqInput.safeParse({ position: 0, faqId: 0 }).success).toBe(false)
  })
})

describe("Freshman authorization", () => {
  it("allows website public-read and dashboard reads, excluding database authors from output", async () => {
    const card = (id: string, group: string) => ({ id, group, ...fields })
    const output = {
      resources: freshmanSlots.filter((slot) => slot.section === "resources").map((slot) => card(slot.id, slot.group)),
      telegram: freshmanSlots.filter((slot) => slot.section === "telegram").map((slot) => card(slot.id, slot.group)),
      faqs: Array.from({ length: 5 }, (_, index) => ({
        faqId: index + 1,
        titleIt: "IT",
        titleEn: "EN",
        descriptionIt: "IT",
        descriptionEn: "EN",
      })),
    }
    db.transaction.mockResolvedValue({ ...output, createdBySub: "private" })
    expect(await freshman.createCaller(context(service, [], ["backend:public:read"])).getContent()).toEqual(output)
    expect(await freshman.createCaller(context(editor, ["admin:access"])).getContent()).toEqual(output)
    await expect(freshman.createCaller(context(service, [], ["backend:tg:read"])).getContent()).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(freshman.createCaller(context(editor, [])).getContent()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it.each([
    context(editor, ["admin:access"]),
    context(service, [], ["backend:public:read"]),
    context(editor, ["web:content:write"], []),
    context(editor, ["web:content:write"], undefined, false),
  ])("denies all mutations without the exact editor boundary", async (ctx) => {
    const caller = freshman.createCaller(ctx)
    await expect(caller.updateCard({ id: "featured-1", ...fields })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller.moveCard({ id: "featured-1", direction: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller.selectFaq({ position: 0, faqId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(db.update).not.toHaveBeenCalled()
    expect(db.transaction).not.toHaveBeenCalled()
  })

  it("takes authorship from the token, ignoring a forged legacy author", async () => {
    await freshman
      .createCaller(context(editor, ["web:content:write"]))
      .updateCard({ id: "featured-1", ...fields, modifiedBy: 999 })
    expect(db.set).toHaveBeenCalledWith({ ...fields, modifiedBy: null, modifiedBySub: "editor" })
  })

  it("rejects crossing a website section before issuing any database write", async () => {
    const caller = freshman.createCaller(context(editor, ["web:content:write"]))
    await expect(caller.moveCard({ id: "featured-2", direction: 1 })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(caller.moveCard({ id: "featured-1", direction: -1 })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect(db.transaction).not.toHaveBeenCalled()
  })
})
