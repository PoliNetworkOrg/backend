import { describe, expect, it, vi } from "vitest"
import type { PeopleRoles, RoleDirectory } from "@/people/roles"
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
    // Within the cache lifetime: the unknown account makes People ask Auth again.
    expect(await h.service.getMyArea(self)).toMatchObject({ state: "match", candidate: { id: "P-0003" } })
    expect(await h.service.listReviews(master)).toEqual([])
  })
})
