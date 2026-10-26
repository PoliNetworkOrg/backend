import { randomUUID } from "node:crypto"
import { vi } from "vitest"
import { transferType } from "@/people/files"
import { newPerson } from "@/people/model"
import { createPeopleService, type PeopleOptions } from "@/people/service"
import {
  type Account,
  emptyState,
  type PeopleConfig,
  type PeopleState,
  type StoredFile,
  type Viewer,
} from "@/people/types"

export const config: PeopleConfig = {
  officers: { president: "P-0001", vicePresident: "P-0002" },
  feeCents: 1000,
  beneficiary: "PoliNetwork APS",
  iban: "IT60X0542811101000000123456",
  legalName: "PoliNetwork APS",
  address: "Via di prova 1, Milano",
  taxCode: "12345678901",
  dashboardUrl: "https://admin.example.org",
}
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
export const permissions = [
  "admin:access",
  "people:self",
  "people:read",
  "people:write",
  "people:members:read",
  "people:members:write",
  "people:fees:write",
  "people:receipts:sign",
  "people:appoint",
  "esign:sign",
]
export const master = viewer("president", permissions)
export const vice = viewer("vice", permissions)

/** A rollback-capable serialized unit of work; production concurrency is tested separately against PostgreSQL. */
export function harness(overrides: Partial<PeopleOptions> = {}) {
  let state = emptyState()
  let files = new Map<string, StoredFile>()
  let tail: Promise<unknown> = Promise.resolve()
  let clock = new Date("2026-10-18T10:00:00Z")
  const requests = new Map<string, { id: string; status: string }>()
  const accounts: Account[] = [
    { sub: "president", name: "Mario Rossi", email: "mario@example.org", emailVerified: true, telegramId: "101" },
    { sub: "vice", name: "Anna Bianchi", email: "anna@example.org", emailVerified: true, telegramId: "102" },
    { sub: "member", name: "Luca Verdi", email: "luca@example.org", emailVerified: true, telegramId: "103" },
  ]
  const store: PeopleOptions["store"] = {
    transaction(fn) {
      const run = tail.then(async () => {
        const draft = structuredClone(state)
        const nextFiles = structuredClone(files)
        const nextRequests = structuredClone(requests)
        const result = await fn({
          state: draft,
          getFile: async (id) => nextFiles.get(id) ?? null,
          putFile: async (file) => {
            nextFiles.set(file.id, file)
          },
          deleteFile: async (id) => {
            nextFiles.delete(id)
          },
          async prepareRequest(receipt) {
            const prior = receipt.requestId ? nextRequests.get(receipt.requestId) : null
            if (!prior || prior.status !== "in_progress") {
              receipt.requestId = randomUUID()
              nextRequests.set(receipt.requestId, { id: receipt.requestId, status: "in_progress" })
            }
            return {
              requestId: receipt.requestId as string,
              title: `Receipt ${receipt.number} · ${receipt.person.name}`,
            }
          },
          async invalidateRequest(receipt) {
            const r = receipt.requestId ? nextRequests.get(receipt.requestId) : null
            if (r) r.status = "cancelled"
          },
        })
        state = draft
        files = nextFiles
        requests.clear()
        for (const [id, request] of nextRequests) requests.set(id, request)
        return result
      })
      tail = run.catch(() => {})
      return run
    },
  }
  const sendMail = vi.fn<PeopleOptions["sendMail"]>().mockResolvedValue(undefined)
  const provisionMember = vi.fn<PeopleOptions["provisionMember"]>().mockImplementation(async (p) => ({
    id: `azure-${p.id}`,
    email: `${p.profile.firstName.toLowerCase()}@polinetwork.org`,
  }))
  const setMemberNumber = vi.fn<PeopleOptions["setMemberNumber"]>().mockResolvedValue(undefined)
  const service = createPeopleService({
    store,
    config,
    now: () => clock,
    directory: async () => accounts,
    telegramUsers: async () => [],
    provisionMember,
    setMemberNumber,
    sendMail,
    verifySigned: async () => {
      throw new Error("No signing fixture")
    },
    inspectSigned: async () => {
      throw new Error("No signing fixture")
    },
    completeSigned: async () => {
      throw new Error("No signing fixture")
    },
    transferType,
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
    files: () => structuredClone(files),
    requests,
    accounts,
    sendMail,
    provisionMember,
    setMemberNumber,
    seed,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms)
    },
    setDate: (d: string) => {
      clock = new Date(d)
    },
  }
}

export async function admit(h: ReturnType<typeof harness>, id = "P-0003", number = "0003") {
  await h.service.createMember(master, { personId: id, number, admittedOn: "2026-10-01", fee: "due" })
}
export async function issue(h: ReturnType<typeof harness>, id = "P-0003") {
  await h.service.markFeePaid(master, {
    personId: id,
    amountCents: 1000,
    paidOn: "2026-10-17",
    method: "cash",
    note: "At the event",
  })
  return Object.values(h.state().receipts).at(-1) as PeopleState["receipts"][string]
}
