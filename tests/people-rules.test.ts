import { describe, expect, it } from "vitest"
import { type BoundRole, type PeopleRoleChange, peopleRoleChangeProblem } from "@/people/rules"
import { BOUND, permissions, viewer } from "./people-fixtures"

const role = (key: string) => BOUND.find((r) => r.key === key) as BoundRole
const change = (overrides: Partial<PeopleRoleChange>): PeopleRoleChange => ({
  actor: viewer("hr", permissions),
  held: [],
  targetSub: null,
  role: role("admin"),
  action: "assign",
  unknownPermissions: "refuse",
  ...overrides,
})

/** The cases of Auth's `people-binding.test.ts`, so both sides refuse the same changes. */
describe("People role rules, as in PoliNetwork Auth", () => {
  it("refuses giving yourself a role, and always lets you give one up", () => {
    const self = viewer("hr", permissions)
    expect(peopleRoleChangeProblem(change({ actor: self, targetSub: "hr" }))).toMatch(/give themselves/)
    expect(peopleRoleChangeProblem(change({ actor: viewer("hr", []), targetSub: "hr", action: "unassign" }))).toBeNull()
  })
  it("needs people:write and admin:access for admins", () => {
    expect(peopleRoleChangeProblem(change({ actor: viewer("hr", ["people:write"]) }))).toMatch(/people:write/)
    expect(peopleRoleChangeProblem(change({ actor: viewer("hr", ["admin:access", "people:write"]) }))).toBeNull()
  })
  it("needs people:appoint for Capo Admins, and people:write for the admin role they inherit", () => {
    const capo = role("capo-admin")
    const writer = viewer("hr", ["admin:access", "people:write", "people:read"])
    expect(peopleRoleChangeProblem(change({ actor: writer, role: capo }))).toMatch(/Capo Admin needs people:appoint/)
    const appointer = viewer("hr", ["admin:access", "people:appoint", "people:read"])
    expect(peopleRoleChangeProblem(change({ actor: appointer, role: capo }))).toBe(
      "Changing this role needs people:write and admin:access."
    )
    expect(peopleRoleChangeProblem(change({ actor: viewer("hr", permissions), role: capo }))).toBeNull()
  })
  it("lets a team's Lead add and remove its members, but not appoint Leads or touch other teams", () => {
    const lead = viewer("lead", ["admin:access"])
    const held = [{ kind: "team" as const, team: "it", role: "lead" as const }]
    expect(peopleRoleChangeProblem(change({ actor: lead, held, role: role("it-member") }))).toBeNull()
    expect(
      peopleRoleChangeProblem(change({ actor: lead, held, role: role("it-member"), action: "unassign" }))
    ).toBeNull()
    expect(peopleRoleChangeProblem(change({ actor: lead, held, role: role("it-lead") }))).toMatch(/Lead needs/)
    expect(peopleRoleChangeProblem(change({ actor: lead, held, role: role("hr-member") }))).toMatch(
      /or leading the team/
    )
  })
  it("applies the rule of every inherited binding: a member role wrapping a Lead needs appointment rights", () => {
    const wrapper: BoundRole = { ...role("it-member"), bindings: ["team:it:member", "team:it:lead"] }
    const lead = viewer("lead", ["admin:access", "people:write"])
    expect(peopleRoleChangeProblem(change({ actor: lead, role: wrapper }))).toMatch(/Lead needs people:appoint/)
  })
  it("bounds delegation: nobody hands out permissions they don't hold, except Master Admin", () => {
    const writer = viewer("hr", ["admin:access", "people:write"])
    expect(peopleRoleChangeProblem(change({ actor: writer, role: role("hr-member") }))).toBeTruthy()
    const lead = viewer("lead", ["admin:access"])
    const held = [{ kind: "team" as const, team: "hr", role: "lead" as const }]
    expect(peopleRoleChangeProblem(change({ actor: lead, held, role: role("hr-member") }))).toBe(
      "This role grants permissions you do not hold (people:read)."
    )
    const master = viewer("master", ["admin:access", "people:write"], ["master-admin"])
    expect(peopleRoleChangeProblem(change({ actor: master, held, role: role("hr-member") }))).toBeNull()
  })
  it("refuses a role whose permissions Auth didn't send for an unlinked record, and defers to Auth for a linked one", () => {
    const opaque: BoundRole = { key: "admin", name: "Admin", binding: "admin" }
    const writer = viewer("hr", ["admin:access", "people:write"])
    expect(peopleRoleChangeProblem(change({ actor: writer, role: opaque }))).toMatch(/didn't say which permissions/)
    expect(
      peopleRoleChangeProblem(change({ actor: writer, role: opaque, targetSub: "luca", unknownPermissions: "defer" }))
    ).toBeNull()
  })
  it("refuses roles that aren't bound to People", () => {
    expect(peopleRoleChangeProblem(change({ role: { key: "x", name: "X", binding: "nope" } }))).toMatch(/not managed/)
  })
})
