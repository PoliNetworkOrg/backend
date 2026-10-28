import { describe, expect, it, vi } from "vitest"
import type { PeopleRoles, RoleDirectory } from "@/people/roles"
import { SOURCE_TTL_MS } from "@/people/service"
import { harness, master, viewer } from "./people-fixtures"

/** Auth's People directory with these accounts; role commands succeed without changing anything. */
function auth(users: RoleDirectory["users"]) {
  const directory: RoleDirectory = {
    roles: [
      { key: "admin", name: "Admin", binding: "admin" },
      { key: "it", name: "IT", binding: "team:it:member" },
    ],
    users,
  }
  const roles: PeopleRoles = {
    directory: vi.fn(async () => structuredClone(directory)),
    change: vi.fn(async (command) => ({
      roles: directory.roles,
      held: users.find((u) => u.sub === command.sub)?.roles ?? [],
      assigned: [],
    })),
  }
  return { directory, roles }
}
const login = (sub: string, extra: Partial<RoleDirectory["users"][number]> = {}) => ({
  sub,
  name: "Luca Verdi",
  email: null,
  verifiedEmail: null,
  azureId: null,
  telegramId: null,
  telegramUsername: null,
  roles: [],
  ...extra,
})

describe("account linking against PoliNetwork Auth's directory", () => {
  it("offers “Is this you?” for a verified email, which Auth now reports", async () => {
    const a = auth([login("luca-login", { email: "luca@gmail.com", verifiedEmail: "luca@example.org" })])
    const h = harness({ peopleRoles: a.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
      p.admin = null
      p.profile.telegramId = null
    })
    const self = viewer("luca-login", ["people:self"])
    expect(await h.service.getMyArea(self)).toMatchObject({
      state: "match",
      candidate: { id: "P-0003" },
      reason: "Same verified email address",
    })
    await h.service.confirmMatch(self)
    expect(h.state().persons["P-0003"]).toMatchObject({ accountSub: "luca-login", account: { status: "linked" } })
  })

  it("links a role holder automatically only by a Microsoft 365 identity", async () => {
    const a = auth([login("luca-login", { azureId: "az-luca", roles: ["it"] })])
    const h = harness({ peopleRoles: a.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
      p.azureId = "az-luca"
    })
    await h.service.syncSources()
    expect(h.state().persons["P-0003"]).toMatchObject({
      accountSub: "luca-login",
      account: { status: "linked", via: "PoliNetwork Auth" },
      teams: [{ team: "it", role: "member" }],
    })
    expect(Object.keys(h.state().persons)).toHaveLength(3)
  })

  it("finds a first sign-in that Auth lists after People last read it", async () => {
    const a = auth([])
    const h = harness({ peopleRoles: a.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
      p.admin = null
    })
    const self = viewer("new-login", ["people:self"])
    expect(await h.service.getMyArea(self)).toMatchObject({ state: "none" })
    a.directory.users.push(login("new-login", { telegramId: "103" }))
    // Within the cache lifetime, an unknown account makes People ask Auth again, at most every 2 seconds.
    expect(await h.service.getMyArea(self)).toMatchObject({ state: "none" })
    h.advance(2_000)
    expect(await h.service.getMyArea(self)).toMatchObject({ state: "match", candidate: { id: "P-0003" } })
    expect(await h.service.listReviews(master)).toEqual([])
  })

  it("keeps a declined match declined: a role holder then gets a record of their own", async () => {
    const a = auth([login("luca-login", { telegramId: "103", roles: ["it"] })])
    const h = harness({ peopleRoles: a.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
    })
    await h.service.syncSources()
    const [review] = await h.service.listReviews(master)
    expect(review).toMatchObject({ kind: "identity-match", record: { id: "P-0003" } })
    await h.service.resolveReview(master, { reviewId: review.id, resolution: "decline", reason: "Different person" })
    h.advance(SOURCE_TTL_MS.directory + 1)
    await h.service.syncSources()
    expect(await h.service.listReviews(master)).toEqual([])
    const persons = Object.values(h.state().persons)
    expect(persons.find((p) => p.accountSub === "luca-login")).toMatchObject({ teams: [{ team: "it" }] })
    expect(h.state().persons["P-0003"].accountSub).toBeNull()
  })

  it("lists a link the account holder made and lets HR undo it for good", async () => {
    const a = auth([login("luca-login", { verifiedEmail: "luca@example.org" })])
    const h = harness({ peopleRoles: a.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
      p.admin = null
      p.profile.personalEmail = "luca@example.org"
      p.profile.telegramId = null
    })
    const self = viewer("luca-login", ["people:self"])
    await h.service.confirmMatch(self)
    expect(await h.service.listRecentLinks(master)).toContainEqual(
      expect.objectContaining({ personId: "P-0003", linkedBy: "account-holder", preliminary: false })
    )
    await h.service.unlinkAccount(master, { personId: "P-0003" })
    expect(h.state().persons["P-0003"]).toMatchObject({ accountSub: null, account: { status: "none" } })
    expect(await h.service.listRecentLinks(master)).not.toContainEqual(expect.objectContaining({ personId: "P-0003" }))
    // “Is this you?” doesn't come back for the same account.
    expect(await h.service.getMyArea(self)).toMatchObject({ state: "none" })
  })

  it("takes the record's roles off the account in Auth when HR undoes the link", async () => {
    const a = auth([login("luca-login", { telegramId: "103", roles: ["it"] })])
    const h = harness({ peopleRoles: a.roles })
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0003"]
      p.accountSub = null
      p.account = { status: "none" }
    })
    await h.service.syncSources()
    const [review] = await h.service.listReviews(master)
    await h.service.resolveReview(master, { reviewId: review.id, resolution: "link-anyway", reason: "Checked" })
    await h.service.unlinkAccount(master, { personId: "P-0003" })
    expect(a.roles.change).toHaveBeenLastCalledWith(
      expect.objectContaining({ sub: "luca-login", changes: [{ kind: "team", team: "it", role: null }] })
    )
    expect(h.state().persons["P-0003"]).toMatchObject({ accountSub: null, profile: { telegramId: null } })
    // Auth no longer lists the role, so the account gets no record of its own.
    a.directory.users[0].roles = []
    h.advance(SOURCE_TTL_MS.directory + 1)
    await h.service.syncSources()
    expect(Object.values(h.state().persons).some((p) => p.accountSub === "luca-login")).toBe(false)
    expect(await h.service.listReviews(master)).toEqual([])
  })

  it("does not reopen a declined preliminary link when Auth's directory is read again", async () => {
    const a = auth([])
    a.directory.users.push({
      ...login("people:1", { name: "Pre Login", email: "pre@example.org" }),
      registrationId: "people:1",
      provisional: true,
      firstName: "Pre",
      lastName: "Login",
    })
    a.directory.users.push(login("real", { name: "Someone", verifiedEmail: "pre@example.org" }))
    const h = harness({ peopleRoles: a.roles, allowLocalPeople: false })
    await h.service.syncSources()
    const [review] = await h.service.listReviews(master)
    expect(review).toMatchObject({ kind: "preliminary-link", account: { name: "Someone" } })
    await h.service.resolveReview(master, { reviewId: review.id, resolution: "decline", reason: "Different person" })
    h.advance(SOURCE_TTL_MS.directory + 1)
    await h.service.syncSources()
    expect(await h.service.listReviews(master)).toEqual([])
  })
})
