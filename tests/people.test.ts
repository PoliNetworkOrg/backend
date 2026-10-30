import { describe, expect, it, vi } from "vitest"
import { myAreaSchema } from "@/people/contract"
import { DIRECTORY_MAX_AGE_MS, DIRECTORY_TTL_MS } from "@/people/service"
import { fakeAuth, harness, master, permissions, profile, viewer } from "./people-fixtures"

const since = "2026-10-01"
const assignmentsOf = (h: ReturnType<typeof harness>, personId: string) =>
  Object.values(h.state().assignments).filter((a) => a.personId === personId)

describe("People records and Auth", () => {
  it("keeps assignments of an unlinked record pending, without telling Auth", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    await h.service.assignAdmin(master, { personId: id, since, capoId: null })
    await h.service.addTeamMember(master, { teamId: "it", personId: id, role: "member", since, fields: {} })
    expect(assignmentsOf(h, id).map((a) => [a.kind, a.status, a.assignedBy])).toEqual([
      ["admin", "pending", "president"],
      ["team", "pending", "president"],
    ])
    expect(h.auth.state.calls).toEqual([])
    const record = await h.service.getPerson(master, { id })
    expect(record.account).toEqual({ status: "none" })
    expect(record.activity.map((a) => a.text)).toEqual(["Joined it as member", "Made admin", "Created the record"])
  })
  it("sends a linked record's change to Auth and shows it applied once Auth confirms it", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    expect(h.auth.state.calls).toEqual([
      {
        id: expect.any(String),
        actor: "president",
        sub: "member",
        reason: "Made admin from People",
        changes: [{ kind: "admin", active: true }],
      },
    ])
    expect(h.auth.held("member")).toEqual(["admin"])
    expect(assignmentsOf(h, "P-0003")).toMatchObject([
      { kind: "admin", status: "applied", change: "start", commandId: null },
    ])
    await h.service.endAdmin(master, { personId: "P-0003", reason: "Graduated" })
    expect(h.auth.held("member")).toEqual([])
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ endedOn: "2026-10-18", change: "end", status: "applied" }])
  })
  it("shows Auth's refusal on the record and fails the dashboard call with it", async () => {
    const h = harness()
    await h.seed()
    h.auth.state.refusal = { status: 403, message: "This role grants permissions you do not hold (people:read)." }
    await expect(
      h.service.addTeamMember(master, { teamId: "hr", personId: "P-0003", role: "member", since, fields: {} })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("you do not hold (people:read)") })
    expect(assignmentsOf(h, "P-0003")).toMatchObject([
      {
        team: "hr",
        status: "refused",
        refusal: "This role grants permissions you do not hold (people:read).",
        endedOn: "2026-10-18",
      },
    ])
    expect(Object.values(h.state().commands)).toMatchObject([{ status: "refused" }])
    expect((await h.service.getPerson(master, { id: "P-0003" })).activity[0].text).toMatch(/PoliNetwork Auth refused/)
  })
  it("keeps the role current when Auth refuses to end it", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    h.auth.state.refusal = { status: 409, message: "The admin role is inherited. Change its granting role in Auth." }
    await expect(h.service.endAdmin(master, { personId: "P-0003", reason: "Done" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(assignmentsOf(h, "P-0003")).toMatchObject([
      { endedOn: null, change: "end", status: "refused", refusal: expect.stringContaining("inherited") },
    ])
  })
  it("creates a linked record for someone given a bound role by hand in Auth, and follows Auth afterwards", async () => {
    const h = harness()
    h.auth.give("giulia", "it-member", "Giulia Gialli Neri", "2026-09-01")
    const [p] = await h.service.listPeople(master)
    expect(p).toMatchObject({
      firstName: "Giulia",
      lastName: "Gialli Neri",
      contactEmail: "giulia@polinetwork.org",
      account: { status: "linked", sub: "giulia" },
      assignments: [{ kind: "team", team: "it", teamRole: "member", since: "2026-09-01", assignedBy: "auth" }],
    })
    h.auth.take("giulia", "it-member")
    h.auth.give("giulia", "it-lead")
    h.advance(DIRECTORY_TTL_MS + 1)
    const [after] = await h.service.listPeople(master)
    expect(after.assignments.map((a) => [a.teamRole, a.endedOn, a.endReason])).toEqual([
      ["member", "2026-10-18", "Changed in PoliNetwork Auth"],
      ["lead", null, null],
    ])
    expect(after.assignments[1].since).toBe("2026-10-18")
    h.auth.take("giulia", "it-lead")
    h.advance(DIRECTORY_TTL_MS + 1)
    const [gone] = await h.service.listPeople(master)
    expect(gone.assignments.every((a) => a.endedOn)).toBe(true)
    expect(Object.keys(h.state().persons)).toEqual(["P-0001"])
  })
  it("relates admins to their Capo Admin's record", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0002", since, capoId: null })
    await h.service.appointCapo(master, { personId: "P-0002", since, scope: "Ingegneria Informatica" })
    expect(h.auth.held("vice")).toEqual(["admin", "capo-admin"])
    await expect(h.service.assignAdmin(master, { personId: "P-0003", since, capoId: "P-0001" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: "P-0002" })
    const capos = await h.service.listCapos(master)
    expect(capos).toMatchObject([
      { person: { id: "P-0002" }, capo: { capoScope: "Ingegneria Informatica" }, admins: [{ id: "P-0003" }] },
    ])
    const admins = await h.service.listAdmins(master)
    expect(admins.find((a) => a.person.id === "P-0003")?.admin.capoOfReference).toEqual({
      id: "P-0002",
      name: "Anna Bianchi",
    })
    const area = await h.service.getCapoArea(viewer("vice", ["people:self"]))
    expect(area).toMatchObject({
      scope: "Ingegneria Informatica",
      admins: [{ id: "P-0003", contactEmail: null, phone: null }],
    })
    await expect(h.service.endAdmin(master, { personId: "P-0002", reason: "x" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await h.service.endCapo(master, { personId: "P-0002", reason: "Stepped down" })
    expect(Object.values(h.state().assignments).find((a) => a.personId === "P-0003")?.capoOfReferenceId).toBeNull()
    expect(h.auth.held("vice")).toEqual(["admin"])
  })
  it("retries a command whose answer was lost with the same ID, and Auth applies it once", async () => {
    const h = harness()
    await h.seed()
    h.auth.state.mode = "lost"
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "sent" }])
    const [command] = Object.values(h.state().commands)
    expect(command).toMatchObject({ status: "queued", attempts: 1 })
    await expect(h.service.endAdmin(master, { personId: "P-0003", reason: "x" })).rejects.toMatchObject({
      code: "CONFLICT",
      message: expect.stringContaining("waiting for PoliNetwork Auth"),
    })
    await h.service.deliverPending()
    expect(h.auth.state.calls.map((c) => c.id)).toEqual([command.id, command.id])
    expect(h.auth.applied.size).toBe(1)
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "applied" }])
    await h.service.deliverPending()
    expect(h.auth.state.calls).toHaveLength(2)
  })
  it("keeps working on Auth's last answer during a short outage, and stops after an hour", async () => {
    const h = harness()
    await h.seed()
    h.auth.give("member", "it-member")
    expect((await h.service.listTeams(master)).find((t) => t.id === "it")?.members).toHaveLength(1)
    h.auth.state.mode = "down"
    h.advance(DIRECTORY_TTL_MS + 1)
    await h.service.assignAdmin(master, { personId: "P-0002", since, capoId: null })
    expect(assignmentsOf(h, "P-0002")).toMatchObject([{ status: "sent" }])
    h.auth.state.mode = "up"
    await h.service.deliverPending()
    expect(assignmentsOf(h, "P-0002")).toMatchObject([{ status: "applied" }])
    h.auth.state.mode = "down"
    h.advance(DIRECTORY_MAX_AGE_MS + 1)
    await expect(h.service.listPeople(master)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
  it("refuses concepts Auth doesn't bind, or binds ambiguously", async () => {
    const h = harness()
    await h.seed()
    await expect(
      h.service.addTeamMember(master, { teamId: "design", personId: "P-0003", role: "member", since, fields: {} })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("No role is bound") })
    const teams = await h.service.listTeams(master)
    expect(teams.find((t) => t.id === "design")?.assignable).toEqual({ member: false, lead: false })
    expect(teams.find((t) => t.id === "hr")?.assignable).toEqual({ member: true, lead: false })
  })
})

describe("Review regressions", () => {
  it("ends a Capo Admin whose binding Auth removed, and takes their area away", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0002", since, capoId: null })
    await h.service.appointCapo(master, { personId: "P-0002", since, scope: "Design" })
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: "P-0002" })
    const capoRole = h.auth.roles.findIndex((r) => r.binding === "capo")
    h.auth.roles.splice(capoRole, 1)
    h.advance(DIRECTORY_TTL_MS + 1)
    await expect(h.service.getCapoArea(viewer("vice", ["people:self"]))).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.listPeople(master)
    expect(Object.values(h.state().assignments).find((a) => a.kind === "capo")).toMatchObject({
      endReason: "No role is bound to it in PoliNetwork Auth",
    })
    expect(Object.values(h.state().assignments).find((a) => a.personId === "P-0003")?.capoOfReferenceId).toBeNull()
  })
  it("keeps the admins' Capo Admin when Auth refuses to end the appointment", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0002", since, capoId: null })
    await h.service.appointCapo(master, { personId: "P-0002", since, scope: "Design" })
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: "P-0002" })
    h.auth.state.refusal = { status: 409, message: "The capo role is inherited. Change its granting role in Auth." }
    await expect(h.service.endCapo(master, { personId: "P-0002", reason: "x" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect((await h.service.listCapos(master))[0].admins).toEqual([{ id: "P-0003", name: "Luca Verdi" }])
    h.auth.state.refusal = null
    await h.service.endCapo(master, { personId: "P-0002", reason: "Stepped down" })
    expect(await h.service.listCapos(master)).toEqual([])
    expect(Object.values(h.state().assignments).find((a) => a.personId === "P-0003")?.capoOfReferenceId).toBeNull()
  })
  it("keeps Auth's last answer as the outage fallback after a confirmed change", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    h.auth.state.mode = "down"
    await expect(h.service.listPeople(master)).resolves.toHaveLength(3)
    h.advance(DIRECTORY_MAX_AGE_MS + 1)
    await expect(h.service.listPeople(master)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })
  it("keeps a command queued when Auth refuses the backend itself, not the change", async () => {
    const h = harness()
    await h.seed()
    h.auth.state.refusal = { status: 403, message: "Forbidden" }
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "sent", endedOn: null }])
    h.auth.state.refusal = null
    await h.service.deliverPending()
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "applied" }])
  })
  it("sends Auth reasons it accepts, however long the link reason", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    await h.service.linkAccount(master, { personId: "P-0003", accountId: "member", reason: "x".repeat(500) })
    expect(h.auth.state.calls[0].reason.length).toBeLessThanOrEqual(500)
  })
  it("lets anyone allowed end a pending assignment even when Auth doesn't send role permissions", async () => {
    const h = harness()
    for (const role of h.auth.roles) {
      delete role.permissions
      delete role.bindings
    }
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    const writer = viewer("vice", ["admin:access", "people:write", "people:read"])
    await expect(h.service.assignAdmin(writer, { personId: id, since, capoId: null })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("didn't say which permissions"),
    })
    await h.service.assignAdmin(viewer("president", permissions, ["master-admin"]), {
      personId: id,
      since,
      capoId: null,
    })
    await h.service.endAdmin(writer, { personId: id, reason: "Mistake" })
    expect(assignmentsOf(h, id)).toMatchObject([{ endedOn: "2026-10-18", status: "pending" }])
  })
  it("never lays an answer from Auth over one from a read that started later", async () => {
    const auth = fakeAuth()
    const gates: (() => void)[] = []
    let hold = true
    const h = harness({
      peopleRoles: {
        change: auth.auth.change,
        async directory() {
          const answer = await auth.auth.directory()
          if (hold) await new Promise<void>((resolve) => gates.push(resolve))
          return answer
        },
      },
    })
    auth.give("member", "it-member", "Luca Verdi")
    const slow = h.service.listPeople(master)
    await vi.waitFor(() => expect(gates).toHaveLength(1))
    hold = false
    auth.take("member", "it-member")
    h.advance(1)
    await expect(h.service.listPeople(master)).resolves.toEqual([])
    gates[0]()
    await expect(slow).resolves.toEqual([])
    expect(h.state().persons).toEqual({})
  })
})

describe("Linking absorbs the record made for roles given in Auth", () => {
  it("folds the automatic record into the one HR made, keeping what Auth holds and HR's data", async () => {
    const h = harness()
    h.auth.give("member", "it-member", "Luca Verdi", "2026-09-01")
    expect((await h.service.listPeople(master)).map((p) => p.id)).toEqual(["P-0001"])
    const { id } = await h.service.createPerson(master, profile("Luca", "Verdi"))
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: id,
      role: "member",
      since,
      fields: { github: "luca" },
    })
    await h.service.assignAdmin(master, { personId: id, since, capoId: null })
    await h.service.linkAccount(viewer("vice", permissions), {
      personId: id,
      accountId: "member",
      reason: "Same person",
    })
    expect(Object.keys(h.state().persons)).toEqual([id])
    const record = await h.service.getPerson(master, { id })
    expect(record.contactEmail).toBe("luca@example.org")
    const current = record.assignments.filter((a) => !a.endedOn)
    expect(current.map((a) => [a.kind, a.status, a.assignedBy])).toEqual([
      ["team", "applied", "auth"],
      ["admin", "applied", "president"],
    ])
    expect(current[0]).toMatchObject({ since: "2026-09-01", fields: { github: "luca" } })
    expect(h.auth.state.calls).toMatchObject([{ actor: "vice", changes: [{ kind: "admin", active: true }] }])
    expect(record.activity.map((a) => a.text)).toContain("Created from a role held in PoliNetwork Auth")
  })
  it("never gives the absorbed record's ID to another record", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, profile("Luca", "Verdi"))
    h.auth.give("member", "it-member", "Luca Verdi")
    h.advance(DIRECTORY_TTL_MS + 1)
    await h.service.linkAccount(viewer("vice", permissions), { personId: id, accountId: "member", reason: "Same" })
    expect(h.history().map((a) => a.text)).toContain(
      "Absorbed P-0002, created for the account's roles in PoliNetwork Auth"
    )
    expect(await h.service.createPerson(master, profile("Sara", "Neri"))).toEqual({ id: "P-0003" })
  })
  it("never merges records people made", async () => {
    const h = harness()
    h.auth.give("member", "it-member", "Luca Verdi")
    await h.service.setNote(master, { id: "P-0001", note: "Checked" })
    const { id } = await h.service.createPerson(master, profile("Luca", "Verdi"))
    await expect(
      h.service.linkAccount(master, { personId: id, accountId: "member", reason: "Same person" })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "This account is already linked to P-0001" })
  })
})

describe("Pending assignments follow Auth's rules", () => {
  it("refuses self-grants on one's own linked record", async () => {
    const h = harness()
    await h.seed()
    await expect(h.service.assignAdmin(master, { personId: "P-0001", since, capoId: null })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Nobody can give themselves a role.",
    })
  })
  it("needs the right permission per kind", async () => {
    const h = harness()
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    const writer = viewer("vice", ["admin:access", "people:write", "people:read"])
    await expect(
      h.service.addTeamMember(writer, { teamId: "it", personId: id, role: "lead", since, fields: {} })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("people:appoint") })
    await h.service.assignAdmin(writer, { personId: id, since, capoId: null })
    await expect(h.service.appointCapo(writer, { personId: id, since, scope: "Design" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("Capo Admin needs"),
    })
  })
  it("lets the Lead Auth knows of manage their team's members, within the permissions they hold", async () => {
    const h = harness()
    await h.seed()
    h.auth.give("vice", "it-lead")
    h.auth.give("vice", "hr-member")
    const lead = viewer("vice", ["admin:access", "people:self", "people:read"])
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    await h.service.addTeamMember(lead, { teamId: "it", personId: id, role: "member", since, fields: {} })
    expect(assignmentsOf(h, id)).toMatchObject([{ team: "it", status: "pending", assignedBy: "vice" }])
    await expect(
      h.service.addTeamMember(lead, { teamId: "hr", personId: "P-0003", role: "member", since, fields: {} })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    expect((await h.service.listTeams(viewer("vice", ["people:self"]))).map((t) => t.id)).toEqual(["it"])
    await h.service.endTeamMembership(lead, { teamId: "it", personId: id, reason: "Left" })
    expect(assignmentsOf(h, id)).toMatchObject([{ endedOn: "2026-10-18", status: "pending" }])
  })
  it("refuses a pending role whose permissions the assigner lacks, even when Auth would only see it at link time", async () => {
    const h = harness()
    await h.seed()
    h.auth.give("vice", "it-lead")
    const lead = viewer("vice", ["admin:access"])
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    await expect(
      h.service.addTeamMember(lead, { teamId: "it", personId: id, role: "member", since, fields: {} })
    ).resolves.toBeUndefined()
    await expect(
      h.service.addTeamMember(master, { teamId: "hr", personId: id, role: "member", since, fields: {} })
    ).resolves.toBeUndefined()
    const writer = viewer("vice", ["admin:access", "people:write"])
    await expect(h.service.appointCapo(writer, { personId: id, since, scope: "x" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const { id: other } = await h.service.createPerson(master, profile("Paolo", "Neri"))
    await expect(
      h.service.addTeamMember(writer, { teamId: "hr", personId: other, role: "member", since, fields: {} })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("(people:read)") })
  })
})

const tokenOf = (h: ReturnType<typeof harness>) =>
  Object.values(h.state().mail)
    .at(-1)
    ?.text.match(/peopleInvite=([A-Za-z0-9_-]{43})/)?.[1] ?? ""

describe("Linking by invite", () => {
  it("links whichever account accepts, acting as each assigner, without People permissions or a matching email", async () => {
    const h = harness()
    await h.seed(false)
    const vice = viewer("vice", permissions)
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    await h.service.addTeamMember(vice, { teamId: "it", personId: "P-0003", role: "member", since, fields: {} })
    await h.service.sendInvite(master, { personId: "P-0003" })
    // Signed in with an account whose email isn't the invited one, holding no People permission.
    const invitee = viewer("luca-google", [])
    expect(await h.service.previewInvite(invitee, { token: tokenOf(h) })).toEqual({
      personId: "P-0003",
      name: "Luca Verdi",
      expiresOn: "2026-11-01",
    })
    await h.service.acceptInvite(invitee, { token: tokenOf(h) })
    expect(h.auth.state.calls.map((c) => [c.actor, c.sub, c.changes]).sort()).toEqual([
      ["president", "luca-google", [{ kind: "admin", active: true }]],
      ["vice", "luca-google", [{ kind: "team", team: "it", role: "member" }]],
    ])
    expect(h.auth.held("luca-google")).toEqual(["admin", "it-member"])
    expect((await h.service.getPerson(master, { id: "P-0003" })).account).toEqual({
      status: "linked",
      sub: "luca-google",
      method: "invite",
      linkedOn: "2026-10-18",
      linkedBy: "luca-google",
    })
  })
  it("uses each token once, until it expires, and only the latest one", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.sendInvite(master, { personId: "P-0003" })
    const first = tokenOf(h)
    await h.service.sendInvite(master, { personId: "P-0003" })
    const second = tokenOf(h)
    const someone = viewer("someone", [])
    await expect(h.service.acceptInvite(someone, { token: first })).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.service.revokeInvite(master, { personId: "P-0003" })
    await expect(h.service.previewInvite(someone, { token: second })).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.service.sendInvite(master, { personId: "P-0002" })
    const late = tokenOf(h)
    h.advance(14 * 86_400_000 + 1)
    await expect(h.service.acceptInvite(someone, { token: late })).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.service.sendInvite(master, { personId: "P-0002" })
    const fresh = tokenOf(h)
    await h.service.acceptInvite(someone, { token: fresh })
    await expect(h.service.acceptInvite(viewer("other", []), { token: fresh })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(h.state().persons["P-0002"].accountSub).toBe("someone")
  })
  it("refuses an account already linked to another record", async () => {
    const h = harness()
    await h.seed()
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    await h.service.sendInvite(master, { personId: id })
    await expect(h.service.acceptInvite(viewer("member", []), { token: tokenOf(h) })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "This account is already linked to P-0003",
    })
    expect(h.state().persons[id].accountSub).toBeNull()
  })
  it("lets a Lead invite their team's members, and nobody else's", async () => {
    const h = harness()
    await h.seed(false)
    h.auth.give("vice", "it-lead")
    await h.service.addTeamMember(master, { teamId: "it", personId: "P-0003", role: "member", since, fields: {} })
    const lead = viewer("vice", ["admin:access", "people:self"])
    await h.service.sendInvite(lead, { personId: "P-0003" })
    await expect(h.service.sendInvite(lead, { personId: "P-0001" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.revokeInvite(lead, { personId: "P-0003" })
  })
  it("keeps on the record what Auth refuses, and applies the rest", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    await h.service.addTeamMember(viewer("vice", permissions), {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since,
      fields: {},
    })
    h.auth.state.refuse = (c) =>
      c.actor === "vice" ? { status: 403, message: "Changing this role needs people:write and admin:access." } : null
    await h.service.sendInvite(master, { personId: "P-0003" })
    await h.service.acceptInvite(viewer("member", []), { token: tokenOf(h) })
    expect(assignmentsOf(h, "P-0003").map((a) => [a.kind, a.status, a.endedOn])).toEqual([
      ["admin", "applied", null],
      ["team", "refused", "2026-10-18"],
    ])
    expect(h.auth.held("member")).toEqual(["admin"])
  })
  it("says in the email that any account will do", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.sendInvite(master, { personId: "P-0003" })
    const [mail] = Object.values(h.state().mail)
    expect(mail.text).toContain("Ciao Luca,")
    expect(mail.text).toContain("Non deve per forza essere questo indirizzo")
    expect(mail.text).toContain("scade il 1 novembre 2026")
  })
})

describe("Linking by hand", () => {
  it("needs people:link, and acts as whoever links", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    const writer = viewer("vice", ["admin:access", "people:write", "people:read"])
    await expect(
      h.service.linkAccount(writer, { personId: "P-0003", accountId: "member", reason: "x" })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("people:link") })
    await expect(h.service.searchAccounts(writer, { query: "" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.linkAccount(viewer("vice", permissions), {
      personId: "P-0003",
      accountId: "member",
      reason: "Checked in person",
    })
    expect(h.auth.state.calls).toMatchObject([
      { actor: "vice", sub: "member", changes: [{ kind: "admin", active: true }] },
    ])
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "applied" }])
    expect(await h.service.listRecentLinks(master)).toEqual([
      {
        person: { id: "P-0003", name: "Luca Verdi" },
        sub: "member",
        email: "luca@example.org",
        method: "manual",
        linkedOn: "2026-10-18",
        linkedBy: "vice",
      },
    ])
    h.advance(31 * 86_400_000)
    expect(await h.service.listRecentLinks(master)).toEqual([])
  })
  it("keeps an assignment Auth refuses at link time on the record as refused", async () => {
    const h = harness()
    await h.seed(false)
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    h.auth.state.refusal = { status: 403, message: "Changing this role needs people:write and admin:access." }
    await h.service.linkAccount(viewer("vice", permissions), { personId: "P-0003", accountId: "member", reason: "x" })
    expect(h.state().persons["P-0003"].accountSub).toBe("member")
    expect(assignmentsOf(h, "P-0003")).toMatchObject([
      { status: "refused", refusal: expect.stringContaining("people:write") },
    ])
  })
  it("refuses your own account and one linked elsewhere", async () => {
    const h = harness()
    await h.seed()
    await expect(
      h.service.linkAccount(master, { personId: "P-0003", accountId: "president", reason: "Test" })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "Ask someone else to link your own account" })
    const { id } = await h.service.createPerson(master, profile("Sara", "Neri"))
    await expect(
      h.service.linkAccount(master, { personId: id, accountId: "vice", reason: "Test" })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "This account is already linked to P-0002" })
  })
})

describe("Unlinking", () => {
  it("takes the roles back in Auth, then detaches the account and puts the assignments back to pending", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    await h.service.addTeamMember(master, { teamId: "it", personId: "P-0003", role: "member", since, fields: {} })
    await expect(
      h.service.unlinkAccount(viewer("vice", ["admin:access", "people:write"]), { personId: "P-0003", reason: "x" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.unlinkAccount(viewer("vice", permissions), { personId: "P-0003", reason: "Wrong person" })
    expect(h.auth.held("member")).toEqual([])
    expect(h.auth.state.calls.at(-1)).toMatchObject({
      actor: "vice",
      changes: [
        { kind: "admin", active: false },
        { kind: "team", team: "it", role: null },
      ],
    })
    expect(h.state().persons["P-0003"]).toMatchObject({ accountSub: null, linkMethod: null })
    expect(assignmentsOf(h, "P-0003").map((a) => [a.kind, a.status, a.endedOn])).toEqual([
      ["admin", "pending", null],
      ["team", "pending", null],
    ])
    // Linking again sends them as for any pending assignment.
    await h.service.linkAccount(viewer("vice", permissions), {
      personId: "P-0003",
      accountId: "member",
      reason: "Right one",
    })
    expect(h.auth.held("member")).toEqual(["admin", "it-member"])
  })
  it("retries a lost answer with the same ID before detaching", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    h.auth.state.mode = "lost"
    await h.service.unlinkAccount(master, { personId: "P-0003", reason: "Wrong person" })
    expect(h.state().persons["P-0003"].accountSub).toBe("member")
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "sent" }])
    await h.service.deliverPending()
    const ids = h.auth.state.calls.slice(-2).map((c) => c.id)
    expect(ids[0]).toBe(ids[1])
    expect(h.state().persons["P-0003"].accountSub).toBeNull()
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "pending", endedOn: null }])
  })
  it("keeps the account linked when Auth refuses", async () => {
    const h = harness()
    await h.seed()
    await h.service.assignAdmin(master, { personId: "P-0003", since, capoId: null })
    h.auth.state.refusal = { status: 409, message: "The admin role is inherited. Change its granting role in Auth." }
    await expect(h.service.unlinkAccount(master, { personId: "P-0003", reason: "x" })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    expect(h.state().persons["P-0003"].accountSub).toBe("member")
    expect(assignmentsOf(h, "P-0003")).toMatchObject([{ status: "applied", endedOn: null }])
  })
  it("detaches at once when Auth holds nothing for the record", async () => {
    const h = harness()
    await h.seed()
    await h.service.unlinkAccount(master, { personId: "P-0003", reason: "Wrong person" })
    expect(h.state().persons["P-0003"].accountSub).toBeNull()
    expect(h.auth.state.calls).toEqual([])
  })
})

describe("People projections", () => {
  it("shows the signed-in person their own record without HR notes or activity", async () => {
    const h = harness()
    await h.seed()
    await h.service.setNote(master, { id: "P-0003", note: "HR only" })
    const mine = await h.service.getMyArea(viewer("member", ["people:self"]))
    expect(myAreaSchema.parse(mine)).toMatchObject({
      state: "linked",
      person: { id: "P-0003", notes: null, activity: [], contactEmail: "luca@example.org" },
    })
    expect(await h.service.getPerson(master, { id: "P-0003" })).toMatchObject({ notes: "HR only" })
  })
  it("hides contacts and account links without people:read", async () => {
    const h = harness()
    await h.seed()
    h.auth.give("vice", "it-lead")
    h.auth.give("member", "it-member")
    const [team] = await h.service.listTeams(viewer("vice", ["people:self"]))
    expect(team.members.find((p) => p.id === "P-0003")).toMatchObject({ account: { status: "none" } })
  })
  it("gives no area to an account without a record", async () => {
    const h = harness()
    const v = viewer("stranger", ["people:self"])
    expect(await h.service.getMyArea(v)).toEqual({ state: "none" })
    expect(await h.service.getMyRoles(v)).toEqual({ capoScope: null, leads: [] })
    await expect(h.service.getCapoArea(v)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})

describe("People mail outbox", () => {
  async function invited() {
    const h = harness()
    await h.seed(false)
    await h.service.sendInvite(master, { personId: "P-0003" })
    const [mail] = Object.values(h.state().mail)
    return { h, mail }
  }
  it("sends a queued invitation once across concurrent workers", async () => {
    const { h, mail } = await invited()
    await Promise.all([h.service.deliverPending(), h.service.deliverPending()])
    expect(h.sendMail).toHaveBeenCalledTimes(1)
    expect(h.sendMail).toHaveBeenCalledWith({
      id: mail.id,
      to: "luca@example.org",
      subject: mail.subject,
      text: expect.stringContaining("https://admin.example.org/dashboard/account/me?peopleInvite="),
    })
    expect(h.state().mail[mail.id]).toMatchObject({ status: "sent", error: null })
    await h.service.deliverPending()
    expect(h.sendMail).toHaveBeenCalledTimes(1)
  })
  it("records a failed send and does not retry it on its own", async () => {
    const { h, mail } = await invited()
    h.sendMail.mockRejectedValueOnce(new Error("Mailbox unavailable"))
    await h.service.deliverPending()
    expect(h.state().mail[mail.id]).toMatchObject({ status: "failed", error: "Mailbox unavailable" })
    await h.service.deliverPending()
    expect(h.sendMail).toHaveBeenCalledTimes(1)
  })
  it("does not resend mail whose outcome is unknown after a crash", async () => {
    const { h, mail } = await invited()
    await h.store.transaction(async ({ state }) => {
      Object.assign(state.mail[mail.id], { status: "sending", attemptedAt: "2026-10-18T09:00:00Z" })
    })
    await h.service.deliverPending()
    expect(h.sendMail).not.toHaveBeenCalled()
    expect(h.state().mail[mail.id]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outcome unknown"),
    })
  })
})
