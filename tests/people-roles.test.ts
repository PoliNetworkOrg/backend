import assert from "node:assert/strict"
import { describe, expect, it, vi } from "vitest"
import {
  type AzureMember,
  type PeopleRoles,
  type RoleChange,
  RoleChangeError,
  type RoleDirectory,
  roleChanges,
} from "@/people/roles"
import { DIRECTORY_MAX_AGE_MS, SOURCE_TTL_MS } from "@/people/service"
import { harness, master, viewer } from "./people-fixtures"

const ROLES: RoleDirectory["roles"] = [
  { key: "admin", name: "Admin", binding: "admin" },
  { key: "it-core", name: "IT Core", binding: "team:it:member" },
  { key: "it-lead", name: "IT Lead", binding: "team:it:lead" },
  { key: "design-member", name: "Member Design & Marketing", binding: "team:design:member" },
  { key: "design-lead", name: "Lead Design & Marketing", binding: "team:design:lead" },
  { key: "odd", name: "Unknown team", binding: "team:chess:member" },
]

/** Atomic, idempotent Auth contract fake. Individual assignment effects are exposed for assertions. */
function fakeAuth(users: RoleDirectory["users"], refuse: (change: RoleChange) => string | null = () => null) {
  const changes: { actor: string; sub: string; role: string; action: "assign" | "unassign"; reason: string }[] = []
  const receipts = new Map<string, string>()
  const result = (sub: string) => ({
    roles: ROLES,
    held: users.find((u) => u.sub === sub)?.roles ?? [],
    assigned: users.find((u) => u.sub === sub)?.roles ?? [],
  })
  const roles: PeopleRoles = {
    directory: vi.fn(async () => structuredClone({ roles: ROLES, users })),
    change: vi.fn(async (command: RoleChange) => {
      if (receipts.has(command.id)) return structuredClone(result(command.sub))
      const reason = refuse(command)
      if (reason) throw new RoleChangeError(403, reason)
      let user = users.find((u) => u.sub === command.sub)
      if (!user) {
        user = { sub: command.sub, name: command.sub, email: null, telegramId: null, telegramUsername: null, roles: [] }
        users.push(user)
      }
      const next = new Set(user.roles)
      for (const change of command.changes) {
        const prefix = change.kind === "admin" ? "admin" : `team:${change.team}:`
        const bound = ROLES.filter((r) => r.binding.startsWith(prefix))
        if (!bound.length) continue
        for (const r of bound) next.delete(r.key)
        const desired =
          change.kind === "admin"
            ? change.active
              ? "admin"
              : null
            : change.role
              ? `team:${change.team}:${change.role}`
              : null
        if (desired) {
          const role = bound.find((r) => r.binding === desired)
          if (!role) throw new RoleChangeError(409, "Missing binding")
          next.add(role.key)
        }
      }
      for (const role of user.roles)
        if (!next.has(role))
          changes.push({ actor: command.actor, sub: command.sub, role, action: "unassign", reason: command.reason })
      for (const role of next)
        if (!user.roles.includes(role))
          changes.push({ actor: command.actor, sub: command.sub, role, action: "assign", reason: command.reason })
      user.roles = [...next].sort()
      receipts.set(command.id, JSON.stringify(command))
      return structuredClone(result(command.sub))
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
  it("sends one desired state per changed concept, leaving concrete assignments to Auth", () => {
    expect(roleChanges({ admin: false, teams: {} }, { admin: true, teams: { it: "member" } })).toEqual([
      { kind: "admin", active: true },
      { kind: "team", team: "it", role: "member" },
    ])
    expect(roleChanges({ admin: false, teams: { it: "lead" } }, { admin: false, teams: {} })).toEqual([
      { kind: "team", team: "it", role: null },
    ])
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
    })
    expect(h.state().persons["P-0003"]).toMatchObject({
      accountSub: "u-tg",
      teams: [{ team: "it", role: "member" }],
    })
    const rows = await h.service.listPeople(master)
    expect(rows.find((r) => r.id === giulia?.id)?.profile.campus).toBeNull()
  })

  it("Auth owns bound concepts on linked records, including legacy local roles", async () => {
    const auth = fakeAuth([user("president", ["admin", "it-core"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    expect(h.state().persons["P-0001"]).toMatchObject({
      admin: { status: "active" },
      teams: [{ team: "it", endedOn: null }],
    })
    // A local role cannot retain authority once its concept is owned by Auth.
    expect(h.state().persons["P-0002"].admin?.status).toBe("former")
    auth.users[0].roles = []
    await h.service.syncSources()
    const p = h.state().persons["P-0001"]
    expect(p.admin).toMatchObject({ status: "former", endReason: "Not held in PoliNetwork Auth" })
    expect(p.teams[0].endedOn).toBe("2026-10-18")
    expect(h.state().persons["P-0002"].admin?.status).toBe("former")
  })

  it("scopes the Capo area to assigned Auth admins without Telegram group data", async () => {
    const auth = fakeAuth([user("president", ["admin"]), user("member", ["admin"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    await h.store.transaction(async ({ state }) => {
      const capo = state.persons["P-0001"].admin
      const former = state.persons["P-0002"].admin
      const active = state.persons["P-0003"].admin
      assert.ok(capo && former && active)
      capo.capoScope = "Ingegneria Informatica"
      const reference = { id: "P-0001", name: "Mario Rossi" }
      former.capoOfReference = reference
      active.capoOfReference = reference
    })
    const capo = viewer("president", ["people:self"])
    const area = await h.service.getCapoArea(capo)
    expect(Object.keys(area).sort()).toEqual(["admins", "scope"])
    expect(area.admins.map((p) => p.id)).toEqual(["P-0003"])
    expect(area.admins[0].profile.personalEmail).toBeNull()
    expect(area.admins[0].member).toBeNull()
    expect(area.admins[0].admin).not.toHaveProperty("groups")
    expect(area.admins[0].admin).not.toHaveProperty("requested")

    auth.users[1].roles = []
    await h.service.syncSources()
    expect((await h.service.getCapoArea(capo)).admins).toEqual([])
    auth.users[0].roles = []
    await h.service.syncSources()
    await expect(h.service.getCapoArea(capo)).rejects.toMatchObject({ code: "FORBIDDEN" })
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
    expect(h.state().persons["P-0003"].teams).toMatchObject([{ team: "design", role: "member", endedOn: null }])
    await h.service.endTeamMembership(master, {
      teamId: "design",
      personId: "P-0003",
      lastDay: "2026-10-18",
      reason: "Moved on",
      note: "",
    })
    expect(auth.changes.at(-1)).toMatchObject({ role: "design-member", action: "unassign", reason: "Moved on" })
    expect(h.state().persons["P-0003"].teams).toMatchObject([{ team: "design", endedOn: "2026-10-18" }])
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
      keepTeams: [],
      reason: "Graduating",
      note: "",
    })
    const p = h.state().persons["P-0003"]
    expect(p.census[0].answer).toBe("leaving")
    expect(
      p.activity.some((a) => a.text.includes("PoliNetwork Auth refused the role change: Refused for the test."))
    ).toBe(true)
  })
})

describe("PoliNetwork Auth unreachable", () => {
  it("notes the failure on a census answer instead of failing it", async () => {
    const auth = fakeAuth([user("member", ["it-core"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    vi.mocked(auth.roles.change).mockRejectedValue(new RoleChangeError(503, "PoliNetwork Auth could not be reached"))
    await h.service.answerCensus(viewer("member", ["people:self"]), {
      answer: "leaving",
      course: "Ingegneria Informatica",
      year: "3rd year",
      campus: "Leonardo",
      keepTeams: [],
      reason: "Graduating",
      note: "",
    })
    const p = h.state().persons["P-0003"]
    expect(p.census[0].answer).toBe("leaving")
    expect(p.activity.some((a) => a.text.includes("didn't answer"))).toBe(true)
    // Still a member until Auth answers: the sweep sends the same command again.
    expect(p.teams[0]).toMatchObject({ team: "it", endedOn: null })
    expect(p.roleCommand?.unanswered).toBe(true)
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

  it("reads the Soci group again only after its cache expires", async () => {
    const azureMembers = vi.fn(async () => [])
    const h = harness({ azureMembers })
    await h.service.sweep()
    await h.service.listPeople(master)
    expect(azureMembers).toHaveBeenCalledTimes(1)
    h.advance(SOURCE_TTL_MS.members)
    await h.service.sweep()
    expect(azureMembers).toHaveBeenCalledTimes(2)
  })

  it("takes who is a member and their number from the Soci group", async () => {
    const members = [member("az-1", "marta.gialli@polinetwork.org", "42")]
    const h = harness({ azureMembers: async () => members })
    h.setDate("2026-10-10T08:00:00Z")
    await h.service.syncSources()
    const id = Object.keys(h.state().persons)[0]
    members[0].employeeId = "43"
    await h.service.syncSources()
    expect(h.state().persons[id].member).toMatchObject({ number: "0043", status: "active" })

    members.length = 0
    await h.service.syncSources()
    expect(h.state().persons[id].member).toMatchObject({ number: "0043", status: "former" })

    members.push(member("az-1", "marta.gialli@polinetwork.org", "43"))
    await h.service.syncSources()
    expect(h.state().persons[id].member?.status).toBe("active")
  })

  it("keeps a member admitted in the last days whom the Soci group listing doesn't show yet", async () => {
    const members = [member("az-1", "marta.gialli@polinetwork.org", "42", { createdOn: "2026-10-09" })]
    const h = harness({ azureMembers: async () => members })
    h.setDate("2026-10-10T08:00:00Z")
    await h.service.syncSources()
    const id = Object.keys(h.state().persons)[0]
    members.length = 0
    await h.service.syncSources()
    expect(h.state().persons[id].member?.status).toBe("active")
    h.setDate("2026-10-12T08:00:00Z")
    await h.service.syncSources()
    expect(h.state().persons[id].member?.status).toBe("former")
  })

  it("leaves memberships alone while Microsoft 365 has never answered", async () => {
    const h = harness({
      azureMembers: async () => {
        throw new Error("Graph unavailable")
      },
    })
    await h.seed()
    const before = Object.values(h.state().persons).filter((p) => p.member?.status === "active").length
    await h.service.syncSources()
    expect(Object.values(h.state().persons).filter((p) => p.member?.status === "active")).toHaveLength(before)
  })
})

describe("Auth is the authority for People role commands", () => {
  it("never leaves a refused linked Lead authorized, even after synchronization", async () => {
    const auth = fakeAuth([], () => "Appointing a Lead requires people:appoint")
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
      p.teams.push({ team: "it", role: "lead", since: "2026-10-01", endedOn: null, endReason: null, fields: {} })
    })
    await h.service.linkAccount(master, { personId: "P-0003", accountId: "member", reason: "Verified identity" })
    // Ended, not deleted, and HR is asked to look at it.
    expect(h.state().persons["P-0003"]).toMatchObject({
      teams: [{ team: "it", role: "lead", since: "2026-10-01", endReason: "Not confirmed by PoliNetwork Auth" }],
      discrepancies: [{ kind: "needs-review", message: expect.stringContaining("people:appoint") }],
    })
    await h.service.syncSources()
    expect(h.state().persons["P-0003"].teams.some((t) => !t.endedOn)).toBe(false)
    await expect(
      h.service.listTeamCandidates(viewer("member", ["people:self"]), { teamId: "it" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("sends the roles of an unlinked record merged into a linked one to Auth", async () => {
    const auth = fakeAuth([user("member", [])])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const first = state.persons["P-0002"]
      first.accountSub = null
      first.account = { status: "none" }
      first.profile.telegramId = null
      first.teams.push({ team: "it", role: "member", since: "2026-10-01", endedOn: null, endReason: null, fields: {} })
      state.reviews.R1 = {
        id: "R1",
        kind: "two-records",
        sub: "member",
        resolved: false,
        rejectedPersonIds: [],
        record: { id: "P-0002" },
        other: { id: "P-0003" },
      } as never
    })
    await h.service.resolveReview(master, { reviewId: "R1", resolution: "merge-first", reason: "Same student" })
    expect(auth.roles.change).toHaveBeenCalled()
    expect(vi.mocked(auth.roles.change).mock.calls[0][0].changes).toContainEqual({
      kind: "team",
      team: "it",
      role: "member",
    })
  })

  it("sends a revocation as one atomic command and preserves confirmed roles when refused", async () => {
    const auth = fakeAuth([user("member", ["it-core", "it-lead"])], () => "Refused")
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    await expect(
      h.service.endTeamMembership(master, {
        personId: "P-0003",
        teamId: "it",
        lastDay: "2026-10-18",
        reason: "Leaving",
        note: "",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect(auth.roles.change).toHaveBeenCalledTimes(1)
    expect(vi.mocked(auth.roles.change).mock.calls[0][0].changes).toEqual([{ kind: "team", team: "it", role: null }])
    expect(auth.users[0].roles).toEqual(["it-core", "it-lead"])
    expect(h.state().persons["P-0003"].teams[0]).toMatchObject({ role: "lead", endedOn: null })
  })

  it("recovers a lost response after restart using the persisted command ID, without granting pending roles", async () => {
    const auth = fakeAuth([])
    const change = auth.roles.change
    auth.roles.change = vi.fn(async (command) => {
      await change(command)
      throw new RoleChangeError(503, "Response lost after commit")
    })
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
    ).rejects.toMatchObject({ message: expect.stringContaining("don't repeat") })
    const pending = h.state().persons["P-0003"].roleCommand
    expect(pending).toBeDefined()
    expect(h.state().persons["P-0003"].teams).toEqual([])
    auth.roles.change = vi.fn(change)
    const restarted = harness({ store: h.store, peopleRoles: auth.roles })
    await restarted.service.sweep()
    expect(vi.mocked(auth.roles.change).mock.calls[0][0].id).toBe(pending?.request.id)
    expect(auth.changes).toHaveLength(1)
    expect(h.state().persons["P-0003"].roleCommand).toBeUndefined()
    expect(h.state().persons["P-0003"].teams[0]).toMatchObject({ team: "it", role: "member", endedOn: null })
  })

  it("does not confirm an inherited revocation refused by Auth", async () => {
    const auth = fakeAuth([user("member", ["it-core"])])
    auth.roles.change = vi.fn(async () => {
      throw new RoleChangeError(409, "The role is inherited. Change its granting role in Auth.")
    })
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    await expect(
      h.service.endTeamMembership(master, {
        personId: "P-0003",
        teamId: "it",
        lastDay: "2026-10-18",
        reason: "Leaving",
        note: "",
      })
    ).rejects.toMatchObject({ message: expect.stringContaining("inherited") })
    expect(h.state().persons["P-0003"].teams[0].endedOn).toBeNull()
  })

  it("refreshes linked identities before importing Microsoft 365 and avoids a duplicate person", async () => {
    const auth = fakeAuth([user("member", ["it-core"], { email: "luca@gmail.com" })])
    let members: AzureMember[] = []
    const h = harness({ peopleRoles: auth.roles, azureMembers: async () => members })
    await h.seed()
    await h.service.syncSources()
    auth.users[0].email = "luca@polinetwork.org"
    auth.users[0].azureId = "azure-luca"
    members = [
      {
        id: "azure-luca",
        mail: "luca@polinetwork.org",
        givenName: "Luca",
        surname: "Verdi",
        displayName: "Luca Verdi",
        employeeId: "42",
        createdOn: "2020-01-01",
      },
    ]
    await h.service.syncSources()
    expect(Object.values(h.state().persons)).toHaveLength(3)
    expect(h.state().persons["P-0003"]).toMatchObject({
      azureId: "azure-luca",
      member: { number: "0042" },
      account: { email: "luca@polinetwork.org" },
    })
  })

  it("does not hold the People transaction open while contacting Auth", async () => {
    const auth = fakeAuth([])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    const change = auth.roles.change
    auth.roles.change = async (command) => {
      await h.service.listPeople(master)
      return change(command)
    }
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: {},
    })
  }, 2000)

  it("does not overwrite a confirmed command with a snapshot fetched before it", async () => {
    const auth = fakeAuth([])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    const old = await auth.roles.directory()
    let release!: (value: RoleDirectory) => void
    let fetched!: () => void
    const started = new Promise<void>((resolve) => {
      fetched = resolve
    })
    vi.mocked(auth.roles.directory).mockImplementationOnce(() => {
      fetched()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    const sync = h.service.syncSources()
    await started
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: {},
    })
    release(old)
    await sync
    expect(h.state().persons["P-0003"].teams[0].endedOn).toBeNull()
  })

  it("keeps reads working and refuses other edits of the person while a command waits for Auth", async () => {
    const auth = fakeAuth([user("member", ["admin", "it-core"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    vi.mocked(auth.roles.change).mockRejectedValueOnce(new RoleChangeError(503, "Timed out"))
    const end = { personId: "P-0003", teamId: "it" as const, lastDay: "2026-10-18", reason: "Leaving", note: "" }
    await expect(h.service.endTeamMembership(master, end)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    // Reading the pending person must not be refused.
    expect((await h.service.getPerson(master, { id: "P-0003" })).admin).toMatchObject({ status: "active" })
    await expect(
      h.service.updateTeamFields(master, { personId: "P-0003", teamId: "it", fields: {} })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(h.service.unlinkAccount(master, { personId: "P-0003" })).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(h.service.endTeamMembership(master, end)).rejects.toMatchObject({ code: "CONFLICT" })
    await h.service.sweep()
    const p = h.state().persons["P-0003"]
    expect(p.roleCommand).toBeUndefined()
    expect(p.teams[0]).toMatchObject({ endedOn: "2026-10-18", endReason: "Leaving" })
    expect(p.admin).toMatchObject({ status: "active" })
    expect(p.activity.filter((a) => a.text.includes("didn't answer"))).toHaveLength(1)
  })

  it("refreshes a linked record's identities without rewriting how it was linked", async () => {
    const auth = fakeAuth([user("member", [], { email: "luca@polinetwork.org", azureId: "azure-luca" })])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    expect(h.state().persons["P-0003"]).toMatchObject({
      azureId: "azure-luca",
      account: { status: "linked", email: "luca@polinetwork.org", via: "IdP", linkedOn: "2026-10-01", how: "test" },
    })
  })

  it("asks HR instead of guessing when Auth and Microsoft 365 identities match different records", async () => {
    const auth = fakeAuth([user("member", ["it-core"], { telegramId: "101" })])
    const h = harness({ peopleRoles: auth.roles })
    await h.seed()
    await h.service.syncSources()
    // P-0001 holds Telegram 101 but is linked to another account: neither record changes hands.
    expect(h.state().persons["P-0001"]).toMatchObject({
      accountSub: "president",
      discrepancies: [{ kind: "needs-review", message: expect.stringContaining("member") }],
    })
    expect(h.state().persons["P-0003"].discrepancies).toHaveLength(1)
  })
})

describe("People reads PoliNetwork Auth on every operation", () => {
  it("shows a role given in Auth without any sync", async () => {
    const auth = fakeAuth([user("u-giulia", ["it-lead"])])
    const h = harness({ peopleRoles: auth.roles })
    const rows = await h.service.listPeople(master)
    expect(rows.find((r) => r.teams.some((t) => t.team === "it" && t.role === "lead" && !t.endedOn))).toBeTruthy()
  })

  it("starts a role when Auth gave it", async () => {
    const auth = fakeAuth([
      user("u-giulia", ["admin", "it-core"], { since: { admin: "2024-09-01", "it-core": "2025-02-10" } }),
    ])
    const h = harness({ peopleRoles: auth.roles })
    const person = (await h.service.listPeople(master)).find((r) => r.admin)
    expect(person?.admin?.since).toBe("2024-09-01")
    expect(person?.teams).toMatchObject([{ team: "it", role: "member", since: "2025-02-10" }])
  })

  it("ends a role taken back in Auth on the next operation after the cache expires", async () => {
    const auth = fakeAuth([user("u-giulia", ["it-lead"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.service.listPeople(master)
    auth.users[0].roles = []
    h.advance(SOURCE_TTL_MS.directory)
    const rows = await h.service.listPeople(master)
    expect(rows.flatMap((r) => r.teams).filter((t) => !t.endedOn)).toEqual([])
  })

  it("refuses to work when Auth has not answered for too long, but rides out a short outage", async () => {
    const auth = fakeAuth([user("u-giulia", ["admin"])])
    const h = harness({ peopleRoles: auth.roles })
    await h.service.listPeople(master)
    vi.mocked(auth.roles.directory).mockRejectedValue(new Error("down"))
    h.advance(SOURCE_TTL_MS.directory)
    await expect(h.service.listPeople(master)).resolves.toBeTruthy()
    h.advance(DIRECTORY_MAX_AGE_MS)
    await expect(h.service.listPeople(master)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
})
