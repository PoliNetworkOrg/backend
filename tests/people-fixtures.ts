import { vi } from "vitest"
import { newPerson } from "@/people/model"
import { createPeopleService, type PeopleOptions } from "@/people/service"
import { type Account, emptyState, type Viewer } from "@/people/types"

export const profile = (firstName = "Mario", lastName = "Rossi") => ({
  firstName,
  lastName,
  personalEmail: `${firstName.toLowerCase()}@example.org`,
  phone: "+3902000000",
  telegramUsername: `${firstName.toLowerCase()}_test`,
  course: "Ingegneria Informatica",
  year: "2nd year" as const,
  campus: "Leonardo" as const,
  admin: true,
})
export const viewer = (sub: string, permissions: string[], telegramId: string | null = null): Viewer => ({
  sub,
  telegramId,
  can: (key) => permissions.includes(key),
})
export const permissions = ["admin:access", "people:self", "people:read", "people:write", "people:appoint"]
export const master = viewer("president", permissions)

/** A rollback-capable serialized unit of work; production concurrency is tested separately against PostgreSQL. */
export function harness(overrides: Partial<PeopleOptions> = {}) {
  let state = emptyState()
  let tail: Promise<unknown> = Promise.resolve()
  let clock = new Date("2026-10-18T10:00:00Z")
  const accounts: Account[] = [
    { sub: "president", name: "Mario Rossi", email: "mario@example.org", telegramId: "101" },
    { sub: "vice", name: "Anna Bianchi", email: "anna@example.org", telegramId: "102" },
    { sub: "member", name: "Luca Verdi", email: "luca@example.org", telegramId: "103" },
  ]
  const store: PeopleOptions["store"] = {
    transaction(fn) {
      const run = tail.then(async () => {
        const draft = structuredClone(state)
        const result = await fn({ state: draft })
        state = draft
        return result
      })
      tail = run.catch(() => {})
      return run
    },
  }
  const sendMail = vi.fn<PeopleOptions["sendMail"]>().mockResolvedValue(undefined)
  const service = createPeopleService({
    store,
    dashboardUrl: "https://admin.example.org",
    now: () => clock,
    directory: async () => accounts,
    sendMail,
    ...overrides,
  })
  async function seed() {
    await store.transaction(async ({ state: s }) => {
      const people = [
        newPerson(s, profile(), "2026-10-01"),
        newPerson(s, profile("Anna", "Bianchi"), "2026-10-01"),
        newPerson(s, profile("Luca", "Verdi"), "2026-10-01"),
      ]
      for (const [i, p] of people.entries()) {
        p.accountSub = accounts[i].sub
        p.profile.telegramId = accounts[i].telegramId
        p.account = {
          status: "linked",
          email: accounts[i].email ?? "",
          via: "IdP",
          linkedOn: "2026-10-01",
          how: "test",
        }
      }
    })
  }
  return {
    service,
    store,
    state: () => structuredClone(state),
    accounts,
    sendMail,
    seed,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
  }
}
