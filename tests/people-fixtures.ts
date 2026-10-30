import { vi } from "vitest"
import { log, newPerson } from "@/people/model"
import { createPeopleService, type PeopleOptions } from "@/people/service"
import { type Account, type Activity, emptyState, type UnitOfWork, type Viewer } from "@/people/types"

type Merge = UnitOfWork["merges"][number]

import { fakeAuth } from "./people-auth"

export { BOUND, fakeAuth } from "./people-auth"

export const profile = (firstName = "Mario", lastName = "Rossi") => ({
  firstName,
  lastName,
  contactEmail: `${firstName.toLowerCase()}@example.org`,
  phone: "+3902000000",
  telegramUsername: `${firstName.toLowerCase()}_test`,
})
export const viewer = (sub: string, permissions: string[], roles: string[] = []): Viewer => ({
  sub,
  telegramId: null,
  can: (key) => permissions.includes(key),
  holdsRole: (key) => roles.includes(key),
})
export const permissions = ["admin:access", "people:self", "people:read", "people:write", "people:appoint"]
/** HR with every People permission, and nothing else Auth knows of. */
export const master = viewer("president", permissions)

/** A rollback-capable serialized unit of work; production concurrency is tested separately against PostgreSQL. */
export function harness(overrides: Partial<PeopleOptions> = {}) {
  let state = emptyState()
  let history: Activity[] = []
  let tail: Promise<unknown> = Promise.resolve()
  let clock = new Date("2026-10-18T10:00:00Z")
  const accounts: Account[] = [
    { sub: "president", name: "Mario Rossi", email: "mario@example.org" },
    { sub: "vice", name: "Anna Bianchi", email: "anna@example.org" },
    { sub: "member", name: "Luca Verdi", email: "luca@example.org" },
  ]
  const store: PeopleOptions["store"] = {
    transaction(fn) {
      const run = tail.then(async () => {
        const draft = { state: structuredClone(state), activity: [] as Activity[], merges: [] as Merge[] }
        const result = await fn(draft)
        state = draft.state
        history = [...history, ...draft.activity].map((a) => {
          const merge = draft.merges.find((m) => m.from === a.personId)
          return merge ? { ...a, personId: merge.into } : a
        })
        return result
      })
      tail = run.catch(() => {})
      return run
    },
    async activity(personId) {
      return history.filter((a) => a.personId === personId).reverse()
    },
  }
  const auth = fakeAuth()
  const sendMail = vi.fn<PeopleOptions["sendMail"]>().mockResolvedValue(undefined)
  const service = createPeopleService({
    store,
    dashboardUrl: "https://admin.example.org",
    now: () => clock,
    directory: async () => accounts,
    peopleRoles: auth.auth,
    sendMail,
    ...overrides,
  })
  /** P-0001 Mario (president), P-0002 Anna (vice), P-0003 Luca (member), all linked. */
  async function seed(linked = true) {
    await store.transaction(async (u) => {
      const people = [profile(), profile("Anna", "Bianchi"), profile("Luca", "Verdi")].map((p) =>
        newPerson(u.state, p, "seed", clock)
      )
      for (const [i, p] of people.entries()) {
        if (linked) p.accountSub = accounts[i].sub
        log(u, p.id, "seed", "Seeded", clock)
      }
    })
  }
  return {
    service,
    store,
    auth,
    state: () => structuredClone(state),
    history: () => [...history],
    accounts,
    sendMail,
    seed,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}
