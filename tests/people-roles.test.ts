import { describe, expect, it, vi } from "vitest"
import {
  type AzureMember,
  boundRoles,
  type PeopleRoles,
  type RoleChange,
  RoleChangeError,
  type RoleDirectory,
  roleChanges,
} from "@/people/roles"
import { SYNC_INTERVAL_MS } from "@/people/service"
import { harness, master, viewer } from "./people-fixtures"

const ROLES: RoleDirectory["roles"] = [
  { key: "admin", name: "Admin", binding: "admin" },
  { key: "it-core", name: "IT Core", binding: "team:it:member" },
  { key: "it-lead", name: "IT Lead", binding: "team:it:lead" },
  { key: "design-member", name: "Member Design & Marketing", binding: "team:design:member" },
  { key: "design-lead", name: "Lead Design & Marketing", binding: "team:design:lead" },
  { key: "odd", name: "Unknown team", binding: "team:chess:member" },
]

/** An in-memory PoliNetwork Auth: `refuse` returns a reason to refuse a change. */
function fakeAuth(users: RoleDirectory["users"], refuse: (change: RoleChange) => string | null = () => null) {
  const changes: RoleChange[] = []
  const roles: PeopleRoles = {
    directory: vi.fn(async () => structuredClone({ roles: ROLES, users })),
    change: vi.fn(async (change: RoleChange) => {
      const reason = refuse(change)
      if (reason) throw new RoleChangeError(403, reason)
      changes.push(change)
      let user = users.find((u) => u.sub === change.sub)
      if (!user) {
        user = { sub: change.sub, name: change.sub, email: null, telegramId: null, telegramUsername: null, roles: [] }
        users.push(user)
      }
      user.roles =
        change.action === "assign"
          ? [...new Set([...user.roles, change.role])].sort()
          : user.roles.filter((role) => role !== change.role)
    }),
  }
  return { roles, changes, users }
}

const user = (sub: string, roles: string[], extra: Partial<RoleDirectory["users"][number]> = {}) => ({
  sub,
  name: "Giulia Neri",
  email: null,
  telegramId: null,
  telegramUsername: null,
  roles,
  ...extra,
})

describe("roleChanges", () => {
  const bound = boundRoles({ roles: ROLES, users: [] })
  it("ignores bindings to teams People doesn't have", () => {
    expect(Object.values(bound.teams).flatMap((t) => [...t.member, ...t.lead])).not.toContain("odd")
  })
  it("gives the bound role for a new entry and takes back every role behind an ended one, Lead first", () => {
    expect(roleChanges(bound, [], { admin: false, teams: {} }, { admin: true, teams: { it: "member" } })).toEqual([
      { role: "admin", action: "assign" },
      { role: "it-core", action: "assign" },
    ])
    expect(
      roleChanges(bound, ["it-core", "it-lead"], { admin: false, teams: { it: "lead" } }, { admin: false, teams: {} })
    ).toEqual([
      { role: "it-lead", action: "unassign" },
      { role: "it-core", action: "unassign" },
    ])
  })
  it("doesn't give a role already held", () => {
    expect(roleChanges(bound, ["admin"], { admin: false, teams: {} }, { admin: true, teams: {} })).toEqual([])
  })
})

describe("People mirrors PoliNetwork Auth", () => {
  it("creates and links records for role holders, and links existing ones by Telegram ID", async () => {
    const auth = fakeAuth([
      user("u-new", ["design-lead"], { name: "Giulia Neri", email: "giulia.neri@polinetwork.org" }),
      user("u-tg", ["it-core"], { name: "Luca V.", telegramId: "777", telegramUsername: "lucav" }),
      user("u-none", []),
    ])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      state.persons["P-0003"].accountSub = null
      state.persons["P-0003"].account = { status: "none" }
      state.persons["P-0003"].profile.telegramId = "777"
    })
    await h.service.syncSources()
    const persons = Object.values(h.state().persons)
    expect(persons).toHaveLength(4)
    const giulia = persons.find((p) => p.accountSub === "u-new")
    expect(giulia).toMatchObject({
      profile: { firstName: "Giulia", lastName: "Neri", campus: null, course: "", year: "", personalEmail: null },
      account: { status: "linked", via: "PoliNetwork Auth" },
      teams: [{ team: "design", role: "lead", endedOn: null }],
      synced: { teams: ["design"] },
    })
    expect(h.state().persons["P-0003"]).toMatchObject({
      accountSub: "u-tg",
      teams: [{ team: "it", role: "member" }],
    })
    const rows = await h.service.listPeople(master)
    expect(rows.find((r) => r.id === giulia?.id)?.profile.campus).toBeNull()
  })

  it("ends only the roles it mirrored when they are taken back", async () => {
    const auth = fakeAuth([user("president", ["admin", "it-core"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    expect(h.state().persons["P-0001"]).toMatchObject({
      admin: { status: "active" },
      synced: { admin: true, teams: ["it"] },
    })
    // Anna (vice) was an admin in People before; PoliNetwork Auth never held it, so it stays.
    expect(h.state().persons["P-0002"].admin?.status).toBe("active")
    auth.users[0].roles = []
    await h.service.syncSources()
    const p = h.state().persons["P-0001"]
    expect(p.admin).toMatchObject({ status: "former", endReason: "Role taken back in PoliNetwork Auth" })
    expect(p.teams[0].endedOn).toBe("2026-10-18")
    expect(p.synced).toBeUndefined()
    expect(h.state().persons["P-0002"].admin?.status).toBe("active")
  })

  it("gives and takes back the role when the dashboard changes a linked record", async () => {
    const auth = fakeAuth([])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.addTeamMember(master, {
      teamId: "design",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: {},
    })
    expect(auth.changes).toEqual([
      { actor: "president", sub: "member", role: "design-member", action: "assign", reason: expect.any(String) },
    ])
    expect(h.state().persons["P-0003"].synced).toEqual({ teams: ["design"] })
    await h.service.endTeamMembership(master, {
      teamId: "design",
      personId: "P-0003",
      lastDay: "2026-10-18",
      reason: "Moved on",
      note: "",
    })
    expect(auth.changes.at(-1)).toMatchObject({ role: "design-member", action: "unassign", reason: "Moved on" })
    expect(h.state().persons["P-0003"].synced).toBeUndefined()
  })

  it("rolls the dashboard change back when PoliNetwork Auth refuses it", async () => {
    const auth = fakeAuth([], () => "This role grants permissions you do not hold (tg:trusted).")
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await expect(
      h.service.addTeamMember(master, {
        teamId: "it",
        personId: "P-0003",
        role: "member",
        since: "2026-10-01",
        fields: {},
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("tg:trusted") })
    expect(h.state().persons["P-0003"].teams).toEqual([])
  })

  it("keeps unlinked records owned by People", async () => {
    const auth = fakeAuth([])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    const { id } = await h.service.createPerson(master, {
      firstName: "Sara",
      lastName: "Blu",
      personalEmail: "sara@example.org",
      phone: "",
      telegramUsername: "",
      course: "Design della Comunicazione",
      year: "1st year",
      campus: "Bovisa",
      admin: false,
    })
    await h.service.addTeamMember(master, {
      teamId: "design",
      personId: id,
      role: "member",
      since: "2026-10-01",
      fields: {},
    })
    expect(auth.roles.change).not.toHaveBeenCalled()
  })

  it("notes a refused census change instead of failing the answer", async () => {
    const auth = fakeAuth([user("member", ["it-core"])], () => "Refused for the test.")
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    await h.service.answerCensus(viewer("member", ["people:self"]), {
      answer: "leaving",
      course: "Ingegneria Informatica",
      year: "3rd year",
      campus: "Leonardo",
      keepGroups: [],
      keepTeams: [],
      reason: "Graduating",
      note: "",
    })
    const p = h.state().persons["P-0003"]
    expect(p.census[0].answer).toBe("leaving")
    expect(p.activity.some((a) => a.text.includes("Couldn't update PoliNetwork Auth: Refused for the test."))).toBe(
      true
    )
  })
})

describe("People mirrors the Microsoft 365 Soci group", () => {
  const member = (id: string, mail: string, employeeId: string | null, extra: Partial<AzureMember> = {}) => ({
    id,
    mail,
    givenName: "Marta",
    surname: "Gialli",
    displayName: "Marta Gialli",
    employeeId,
    createdOn: "2025-03-02",
    ...extra,
  })

  it("adds members with their number, merges with linked accounts and flags unusable numbers", async () => {
    const auth = fakeAuth([user("u-marta", ["it-core"], { email: "marta.gialli@polinetwork.org" })])
    const members = [
      member("az-1", "marta.gialli@polinetwork.org", "42"),
      member("az-2", "nonumber@polinetwork.org", null, { givenName: "Paolo", surname: "Viola" }),
    ]
    const h = harness({ peopleRoles: auth.roles, azureMembers: async () => members })
    await h.service.syncSources()
    const persons = Object.values(h.state().persons)
    expect(persons).toHaveLength(2)
    expect(persons[0]).toMatchObject({
      accountSub: "u-marta",
      azureId: "az-1",
      member: { number: "0042", status: "active", admittedOn: "2025-03-02", m365Email: "marta.gialli@polinetwork.org" },
      teams: [{ team: "it" }],
    })
    expect(persons[1]).toMatchObject({ member: null, discrepancies: [{ kind: "needs-review" }] })
    await h.service.syncSources()
    expect(Object.values(h.state().persons)).toHaveLength(2)
    expect(h.state().persons[persons[1].id].discrepancies).toHaveLength(1)
  })

  it("sends no automatic fee reminders for the year a membership was imported", async () => {
    const h = harness({ azureMembers: async () => [member("az-1", "marta.gialli@polinetwork.org", "42")] })
    h.setDate("2026-10-28T08:00:00Z")
    await h.service.sweep()
    expect(Object.keys(h.state().outbox)).toEqual([])
  })

  it("syncs from the sweep at most once per interval", async () => {
    const azureMembers = vi.fn(async () => [])
    const h = harness({ azureMembers })
    await h.service.sweep()
    await h.service.sweep()
    expect(azureMembers).toHaveBeenCalledTimes(1)
    h.advance(SYNC_INTERVAL_MS)
    await h.service.sweep()
    expect(azureMembers).toHaveBeenCalledTimes(2)
  })
})
