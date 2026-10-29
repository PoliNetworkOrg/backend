import { describe, expect, it } from "vitest"
import { myAreaSchema } from "@/people/contract"
import { harness, master, viewer } from "./people-fixtures"

describe("People authorization and projections", () => {
  it("shows the signed-in person their own record without HR notes or activity", async () => {
    const h = harness()
    await h.seed()
    await h.service.setNote(master, { id: "P-0003", note: "HR only" })
    const mine = await h.service.getMyArea(viewer("member", ["people:self"]))
    expect(myAreaSchema.parse(mine)).toMatchObject({
      state: "linked",
      person: { id: "P-0003", notes: null, activity: [], profile: { personalEmail: "luca@example.org" } },
    })
    expect(JSON.stringify(mine)).not.toContain("accountSub")
    expect(await h.service.getPerson(master, { id: "P-0003" })).toMatchObject({ notes: "HR only" })
  })
  it("scopes Leads to their confirmed teams and requires appointment rights to end another Lead", async () => {
    const h = harness()
    await h.seed()
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0001",
      role: "lead",
      since: "2026-10-01",
      fields: {},
    })
    const lead = viewer("president", ["people:self", "people:read"])
    expect((await h.service.listTeams(lead)).map((t) => t.id)).toEqual(["it"])
    await h.service.addTeamMember(lead, {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: { areas: ["Backend"] },
    })
    await expect(h.service.listTeamCandidates(lead, { teamId: "hr" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.service.endTeamMembership(lead, {
        teamId: "it",
        personId: "P-0001",
        lastDay: "2026-10-18",
        reason: "Leaving",
        note: "",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.endTeamMembership(lead, {
      teamId: "it",
      personId: "P-0003",
      lastDay: "2026-10-18",
      reason: "Leaving",
      note: "",
    })
    expect(h.state().persons["P-0003"].teams[0].endedOn).toBe("2026-10-18")
  })
  it("does not expose former team members to a Team Lead", async () => {
    const h = harness()
    await h.seed()
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0001",
      role: "lead",
      since: "2026-10-01",
      fields: {},
    })
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: {},
    })
    await h.service.endTeamMembership(master, {
      teamId: "it",
      personId: "P-0003",
      lastDay: "2026-10-18",
      reason: "Leaving",
      note: "",
    })
    const teams = await h.service.listTeams(viewer("president", ["people:self"]))
    expect(teams[0].members.map((p) => p.id)).toEqual(["P-0001"])
  })
  it("shows a Capo Admin only the admins they are the reference for, without personal emails", async () => {
    const h = harness()
    await h.seed()
    await h.service.setCapoScope(master, { personId: "P-0001", scope: "Ingegneria Informatica" })
    await h.service.setCapoOfReference(master, { personId: "P-0003", capoId: "P-0001" })
    const capo = await h.service.getCapoArea(viewer("president", ["people:self"]))
    expect(capo.scope).toBe("Ingegneria Informatica")
    expect(capo.admins.map((p) => p.id)).toEqual(["P-0003"])
    expect(capo.admins[0].profile.personalEmail).toBeNull()
    await expect(h.service.getCapoArea(viewer("member", ["people:self"]))).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
  it("grants no record roles to an account that is not linked", async () => {
    const h = harness()
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0001"]
      p.accountSub = null
      p.account = { status: "none" }
      if (p.admin) p.admin.capoScope = "IT"
      p.teams.push({ team: "it", role: "lead", since: "2026-10-01", endedOn: null, endReason: null, fields: {} })
    })
    const v = viewer("president", ["people:self"], "101")
    expect(await h.service.getMyArea(v)).toEqual({ state: "none" })
    expect(await h.service.getMyRoles(v)).toEqual({ capoScope: null, leads: [] })
    await expect(h.service.getCapoArea(v)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("prevents account takeover and invalidates old invitation tokens", async () => {
    const h = harness()
    await h.seed()
    await expect(
      h.service.linkAccount(master, { personId: "P-0003", accountId: "president", reason: "Test" })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await h.service.unlinkAccount(master, { personId: "P-0003" })
    await h.service.sendInvite(master, { personId: "P-0003" })
    const first = Object.values(h.state().outbox).at(-1)?.text.split("peopleInvite=")[1] ?? ""
    await h.service.sendInvite(master, { personId: "P-0003" })
    await expect(h.service.acceptInvite(viewer("member", ["people:self"]), { token: first })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const last = Object.values(h.state().outbox).at(-1)?.text.split("peopleInvite=")[1] ?? ""
    await expect(h.service.acceptInvite(viewer("vice", ["people:self"]), { token: last })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await h.service.acceptInvite(viewer("member", ["people:self"]), { token: last })
    expect(h.state().persons["P-0003"].accountSub).toBe("member")
  })
})

describe("People mail outbox", () => {
  async function invited() {
    const h = harness()
    await h.seed()
    await h.service.unlinkAccount(master, { personId: "P-0003" })
    await h.service.sendInvite(master, { personId: "P-0003" })
    const [mail] = Object.values(h.state().outbox)
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
    expect(h.state().outbox[mail.id]).toMatchObject({ status: "sent", error: null })
    await h.service.deliverPending()
    expect(h.sendMail).toHaveBeenCalledTimes(1)
  })
  it("records a failed send and does not retry it on its own", async () => {
    const { h, mail } = await invited()
    h.sendMail.mockRejectedValueOnce(new Error("Mailbox unavailable"))
    await h.service.deliverPending()
    expect(h.state().outbox[mail.id]).toMatchObject({ status: "failed", error: "Mailbox unavailable" })
    await h.service.deliverPending()
    expect(h.sendMail).toHaveBeenCalledTimes(1)
  })
  it("does not resend mail whose outcome is unknown after a crash", async () => {
    const { h, mail } = await invited()
    await h.store.transaction(async ({ state }) => {
      Object.assign(state.outbox[mail.id], { status: "sending", attemptedAt: "2026-10-18T09:00:00Z" })
    })
    await h.service.deliverPending()
    expect(h.sendMail).not.toHaveBeenCalled()
    expect(h.state().outbox[mail.id]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outcome unknown"),
    })
  })
})
