import type { Actor } from "@polinetwork/auth-kit"
import { TRPCError } from "@trpc/server"
import { describe, expect, it } from "vitest"
import { z } from "zod/v4"
import { auditEvent, auditJson } from "@/audit"

describe("auditJson", () => {
  it("hides secrets and describes files instead of copying them", () => {
    const form = new FormData()
    form.set("name", "PoliNetwork")
    form.set("logo", new File([new Uint8Array(3)], "logo.png", { type: "image/png" }))
    expect(
      auditJson({
        form,
        password: "hunter2",
        ticket: "abc",
        idempotencyKey: "k",
        bytes: new Uint8Array(4),
        at: new Date(0),
      })
    ).toEqual({
      form: { name: "PoliNetwork", logo: { file: "logo.png", type: "image/png", size: 3 } },
      password: "(hidden)",
      ticket: "(hidden)",
      idempotencyKey: "(hidden)",
      bytes: "(4 bytes)",
      at: "1970-01-01T00:00:00.000Z",
    })
  })

  it("cuts long strings and arrays", () => {
    const copy = auditJson({ text: "x".repeat(2500), list: Array.from({ length: 103 }, (_, i) => i) })
    expect(copy).toMatchObject({ text: `${"x".repeat(2000)}… (2500 characters)` })
    expect((copy as { list: unknown[] }).list).toHaveLength(101)
    expect((copy as { list: unknown[] }).list.at(-1)).toBe("(3 more)")
  })

  it("cuts objects with many fields, and copies too large to keep", () => {
    const fields = Object.fromEntries(Array.from({ length: 103 }, (_, i) => [`k${i}`, i]))
    const copy = auditJson(fields) as Record<string, unknown>
    expect(Object.keys(copy)).toHaveLength(101)
    expect(copy["(more)"]).toBe("3 more fields")

    const large = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "x".repeat(2000)]))
    expect(auditJson(large)).toMatch(/^\(\d+ characters, too large to keep\)$/)
  })

  it("hides whole secret names and camelCase secret suffixes only", () => {
    expect(
      auditJson({ code: "1", apiKey: "2", clientSecret: "3", courseCode: "054321", countryCode: "IT", monkey: 1 })
    ).toEqual({
      code: "(hidden)",
      apiKey: "(hidden)",
      clientSecret: "(hidden)",
      courseCode: "054321",
      countryCode: "IT",
      monkey: 1,
    })
  })
})

describe("auditEvent", () => {
  const admin: Actor = { kind: "user", client: "admin-dashboard", sub: "usr_admin", telegramId: null }
  const auth = { kind: "token", actor: admin, scopes: new Set(["backend:admin"]) } as const
  const ok = (data: unknown = undefined) => ({ ok: true as const, data })

  it("records nothing for calls without a valid token", () => {
    const rejected = { kind: "rejected", status: 401, reason: "Missing bearer token" } as const
    for (const caller of [undefined, rejected])
      expect(auditEvent({ path: "web.faqs.deleteFaqs", auth: caller, rawInput: {}, note: {}, result: ok() })).toBeNull()
  })

  it("keeps the request id, and no input for denied calls", () => {
    const event = auditEvent({
      path: "web.faqs.deleteFaqs",
      auth,
      requestId: "0b0c8f0e-6a49-4a43-9d53-6a1f9b2f6f0e",
      rawInput: { id: 3, padding: "x".repeat(1000) },
      note: {},
      result: { ok: false, error: new TRPCError({ code: "FORBIDDEN", message: "Missing permission" }) },
    })
    expect(event).toMatchObject({
      requestId: "0b0c8f0e-6a49-4a43-9d53-6a1f9b2f6f0e",
      outcome: "denied",
      input: null,
    })
  })

  it("cuts target ids, labels and reasons the caller chose", () => {
    const event = auditEvent({
      path: "esign.signers.resetIdentity",
      auth,
      rawInput: {},
      note: {
        target: { type: "esign.signer", id: "s".repeat(5000), label: "l".repeat(5000) },
        reason: "r".repeat(5000),
      },
      result: ok(),
    })
    for (const value of [event?.targetId, event?.targetLabel, event?.reason]) expect(value?.length).toBeLessThan(2100)
  })

  it("names a person only by a valid People id", () => {
    const event = auditEvent({
      path: "people.persons.setNote",
      auth,
      rawInput: { id: "ada@example.org", note: "" },
      note: {},
      result: { ok: false, error: new TRPCError({ code: "BAD_REQUEST", message: "Invalid input" }) },
    })
    expect(event).toMatchObject({ targetType: "people.person", targetId: null, input: null })
  })

  it("lists the issues of an invalid input rather than their JSON", () => {
    const invalid = z.object({ id: z.number(), title: z.string() }).safeParse({ id: "x" })
    const event = auditEvent({
      path: "web.faqs.editFaqs",
      auth,
      rawInput: { id: "x" },
      note: {},
      result: { ok: false, error: new TRPCError({ code: "BAD_REQUEST", cause: invalid.error }) },
    })
    expect(event?.outcome).toBe("failure")
    expect(event?.error).toMatch(/^id: .+; title: .+$/)
  })

  it("names several targets by their number, without an id", () => {
    const event = auditEvent({
      path: "web.reports.resolve",
      auth,
      rawInput: { ids: [1, 2] },
      note: { target: { type: "web.report", id: null, label: "2 reports" } },
      result: ok([]),
    })
    expect(event).toMatchObject({ targetType: "web.report", targetId: null, targetLabel: "2 reports" })
  })

  it("keeps only the actor, the action, the person and the outcome for People", () => {
    const note = auditEvent({
      path: "people.persons.setNote",
      auth,
      rawInput: { id: "P-0001", note: "private HR note" },
      note: {},
      result: ok(),
    })
    expect(note).toMatchObject({
      action: "people.persons.setNote",
      actorSub: "usr_admin",
      targetType: "people.person",
      targetId: "P-0001",
      outcome: "success",
      input: null,
      before: null,
      after: null,
    })

    const created = auditEvent({
      path: "people.persons.create",
      auth,
      rawInput: { name: "Ada", contactEmail: "ada@example.org", phone: "+39 000" },
      note: {},
      result: ok({ id: "P-0002" }),
    })
    expect(created).toMatchObject({ targetId: "P-0002", input: null })

    const ended = auditEvent({
      path: "people.admins.end",
      auth,
      rawInput: { personId: "P-0003", reason: "stepped down" },
      note: {},
      result: ok(),
    })
    expect(ended).toMatchObject({ targetId: "P-0003", reason: null, input: null })
  })
})
