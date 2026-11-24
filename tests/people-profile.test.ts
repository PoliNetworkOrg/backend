import type { Actor } from "@polinetwork/auth-kit"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { createPersonInputSchema, updatePersonInputSchema } from "@/people/contract"
import type { Context } from "@/trpc"
import { COURSES, harness, master, permissions, profile, viewer } from "./people-fixtures"

const events = vi.hoisted(() => ({ write: vi.fn() }))
vi.mock("@/audit/store", () => ({ writeAuditEvent: events.write }))

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
function context(granted = permissions): Context {
  const actor: Actor = { kind: "user", sub: "president", client: "admin-dashboard", telegramId: "101" }
  return {
    auth: { kind: "token", actor, scopes: new Set(["backend:admin"]) },
    access: {
      has: (_, p) => granted.includes(p),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ fresh: true, generation: 1, subjects: 1, lastSyncAt: 1 }),
    },
  }
}

const representative = {
  courseCode: 531,
  campus: "leonardo" as const,
  otherAssociations: ["Svoltastudenti", "POuL"],
  representativeRoles: ["ccs" as const, "other" as const],
  representativeOther: "Comitato Sportivo",
}
const create = (input: Record<string, unknown>) =>
  createPersonInputSchema.parse({ ...profile("Sara", "Neri"), ...input })
const update = (id: string, input: Record<string, unknown>) =>
  updatePersonInputSchema.parse({ ...profile("Sara", "Neri"), id, ...input })

describe("People profile fields", () => {
  it("starts empty when a create leaves them out", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, create({}))
    const record = await h.service.getPerson(master, { id })
    expect(record).toMatchObject({
      course: null,
      campus: null,
      otherAssociations: [],
      representativeRoles: [],
      representativeOther: null,
    })
  })

  it("saves them on create, returns the course and logs each one", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, create(representative))
    const record = await h.service.getPerson(master, { id })
    expect(record).toMatchObject({
      course: COURSES[0],
      campus: "leonardo",
      otherAssociations: ["Svoltastudenti", "POuL"],
      representativeRoles: ["ccs", "other"],
      representativeOther: "Comitato Sportivo",
    })
    expect(record.activity.map((a) => a.text)).toEqual([
      "Representative roles set to CCS, Other (Comitato Sportivo)",
      "Other associations set to Svoltastudenti, POuL",
      "Campus set to Leonardo",
      "Course set to Ingegneria Informatica (531)",
      "Created the record",
    ])
  })

  it("leaves them unchanged when an update leaves them out", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, create(representative))
    await h.service.updatePerson(master, update(id, { phone: "+39 02 1234" }))
    expect(h.state().persons[id]).toMatchObject({
      phone: "+39 02 1234",
      courseCode: 531,
      campus: "leonardo",
      otherAssociations: ["Svoltastudenti", "POuL"],
      representativeRoles: ["ccs", "other"],
      representativeOther: "Comitato Sportivo",
    })
  })

  it("changes and clears them on update, clearing the seat's name with Other", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, create(representative))
    await h.service.updatePerson(
      master,
      update(id, { courseCode: 1162, campus: null, otherAssociations: [], representativeRoles: ["senate"] })
    )
    expect(h.state().persons[id]).toMatchObject({
      courseCode: 1162,
      campus: null,
      otherAssociations: [],
      representativeRoles: ["senate"],
      representativeOther: null,
    })
    const record = await h.service.getPerson(master, { id })
    expect(record.activity.slice(0, 4).map((a) => a.text)).toEqual([
      "Representative roles changed to Senate",
      "Other associations cleared",
      "Campus cleared",
      "Course changed to Design della Comunicazione (1162)",
    ])
  })

  it("needs a name for an Other seat, and only for one", async () => {
    const h = harness()
    expect(() => create({ representativeRoles: ["other"], representativeOther: "" })).toThrow()
    expect(() => create({ representativeRoles: ["senate"], representativeOther: "Comitato" })).toThrow()
    const { id } = await h.service.createPerson(master, create({}))
    // The input alone can't tell: the record it merges into decides.
    await expect(h.service.updatePerson(master, update(id, { representativeRoles: ["other"] }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Name the other seat",
    })
    await expect(h.service.updatePerson(master, update(id, { representativeOther: "Comitato" }))).rejects.toMatchObject(
      {
        code: "BAD_REQUEST",
        message: "Only an Other seat takes a name",
      }
    )
    await h.service.updatePerson(
      master,
      update(id, { representativeRoles: ["other"], representativeOther: "Comitato" })
    )
    await h.service.updatePerson(master, update(id, { representativeOther: "Consiglio di Polo" }))
    expect(h.state().persons[id]).toMatchObject({
      representativeRoles: ["other"],
      representativeOther: "Consiglio di Polo",
    })
  })

  it("needs a course for a CCS or school seat", async () => {
    const h = harness()
    await expect(h.service.createPerson(master, create({ representativeRoles: ["school"] }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "A CCS or school seat needs the person's course",
    })
    const { id } = await h.service.createPerson(master, create(representative))
    await expect(h.service.updatePerson(master, update(id, { courseCode: null }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    expect(h.state().persons[id].courseCode).toBe(531)
  })

  it("refuses an unknown or inactive course, but keeps one that became inactive", async () => {
    const h = harness()
    await expect(h.service.createPerson(master, create({ courseCode: 4242 }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Choose a course from the list",
    })
    await expect(h.service.createPerson(master, create({ courseCode: 358 }))).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "That course is no longer offered: choose one from the list",
    })
    const { id } = await h.service.createPerson(master, create({ courseCode: 531 }))
    await h.store.transaction(async (u) => {
      ;(u.state.courses[531] as (typeof COURSES)[number]).active = false
    })
    await h.service.updatePerson(master, update(id, { courseCode: 531, campus: "cremona" }))
    expect(h.state().persons[id]).toMatchObject({ courseCode: 531, campus: "cremona" })
    expect((await h.service.getPerson(master, { id })).course).toMatchObject({ code: 531, active: false })
  })

  it("drops repeated associations and seats", () => {
    expect(
      create({ otherAssociations: ["Svoltastudenti", " svoltastudenti ", "POuL"], representativeRoles: ["ccs", "ccs"] })
    ).toMatchObject({ otherAssociations: ["Svoltastudenti", "POuL"], representativeRoles: ["ccs"] })
  })

  it("shows associations and seats to People readers only, the course and campus to everyone who sees the row", async () => {
    const h = harness()
    await h.seed()
    await h.service.updatePerson(master, update("P-0003", { ...representative, ...profile("Luca", "Verdi") }))
    // Luca, a team member, sees their own record without people:read.
    const own = viewer("member", ["people:self"])
    const area = await h.service.getMyArea(own)
    expect(area.state === "linked" && area.person).toMatchObject({
      course: { code: 531 },
      campus: "leonardo",
      otherAssociations: [],
      representativeRoles: [],
      representativeOther: null,
    })
    const people = await h.service.listPeople(master)
    expect(people.find((p) => p.id === "P-0003")).toMatchObject({ course: { code: 531 }, campus: "leonardo" })
    expect(people.find((p) => p.id === "P-0003")).not.toHaveProperty("otherAssociations")
  })

  it("lists every course, active or not, in school and level order", async () => {
    const h = harness()
    expect((await h.service.listCourses(master)).map((c) => c.code)).toEqual([358, 531, 1162])
    await expect(h.service.listCourses(viewer("member", ["admin:access", "people:self"]))).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })

  it("suggests one spelling per association, most used first", async () => {
    const h = harness()
    for (const otherAssociations of [["POuL", "Svoltastudenti"], ["svoltastudenti"], ["Svoltastudenti", "AEA"]])
      await h.service.createPerson(master, create({ otherAssociations }))
    expect(await h.service.suggestAssociations(master)).toEqual(["Svoltastudenti", "AEA", "POuL"])
    await expect(h.service.suggestAssociations(viewer("lead", ["admin:access", "people:write"]))).rejects.toMatchObject(
      { code: "FORBIDDEN" }
    )
  })

  it("serves both reads through the router, behind people:read", async () => {
    const h = harness()
    await h.service.createPerson(master, create(representative))
    const r = makeRouter(h.service)
    expect(await r.createCaller(context()).courses.list()).toHaveLength(COURSES.length)
    expect(await r.createCaller(context()).associations.suggest()).toEqual(["POuL", "Svoltastudenti"])
    const noRead = context(permissions.filter((p) => p !== "people:read"))
    await expect(r.createCaller(noRead).courses.list()).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(r.createCaller(noRead).associations.suggest()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("keeps the profile out of the audit event", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, create({}))
    events.write.mockClear()
    await makeRouter(h.service)
      .createCaller(context())
      .persons.update({ ...profile("Sara", "Neri"), id, ...representative })
    expect(events.write).toHaveBeenCalledTimes(1)
    const event = JSON.stringify(events.write.mock.calls[0])
    expect(event).toContain(id)
    for (const value of ["Svoltastudenti", "Comitato Sportivo", "leonardo", "531"]) expect(event).not.toContain(value)
  })
})
