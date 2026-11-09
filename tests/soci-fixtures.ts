import { vi } from "vitest"
import { createMockAzureDirectory } from "@/azure/mock-directory"
import type { AzureDirectory } from "@/azure/types"
import type { AdmitInput, RegisterInput } from "@/soci/contract"
import { admitInputSchema, registerInputSchema } from "@/soci/contract"
import { createSociService, type SociOptions } from "@/soci/service"
import type { ActivityEntry, Socio, SociStore } from "@/soci/types"

/** The register in memory, with the same rules the tables enforce. */
export function memoryStore() {
  const rows: Socio[] = []
  const numbers = new Map<number, number>()
  const history = new Map<number, ActivityEntry[]>()
  const log = (id: number, e: ActivityEntry) => history.set(id, [e, ...(history.get(id) ?? [])])
  const store: SociStore = {
    async list() {
      return structuredClone(rows).sort((a, b) => a.number - b.number)
    },
    async byNumber(number) {
      return structuredClone(rows.find((r) => r.number === number) ?? null)
    },
    async byObjectId(id) {
      return structuredClone(rows.find((r) => r.entraObjectId === id) ?? null)
    },
    async activeByCodiceFiscale(code) {
      return structuredClone(rows.find((r) => r.codiceFiscale === code && !r.endedOn) ?? null)
    },
    async numberOwner(number) {
      return numbers.get(number) ?? null
    },
    async activity(id) {
      return structuredClone(history.get(id) ?? [])
    },
    async insert(socio, entry) {
      if (numbers.has(socio.number)) throw new Error("duplicate key soci_numbers_pkey")
      if (rows.some((r) => r.entraObjectId === socio.entraObjectId)) throw new Error("duplicate entra_object_id")
      if (socio.codiceFiscale && rows.some((r) => r.codiceFiscale === socio.codiceFiscale && !r.endedOn))
        throw new Error("duplicate soci_members_active_codice_fiscale_idx")
      const row = { ...structuredClone(socio), id: rows.length + 1 }
      rows.push(row)
      numbers.set(row.number, row.id)
      log(row.id, entry)
      return structuredClone(row)
    },
    async update(id, changes, entry) {
      const row = rows.find((r) => r.id === id) as Socio
      Object.assign(row, structuredClone(changes))
      log(id, entry)
    },
    async changeNumber(id, number, entry) {
      const owner = numbers.get(number)
      if (owner !== undefined && owner !== id) throw new Error("number taken")
      numbers.set(number, id)
      const row = rows.find((r) => r.id === id) as Socio
      row.number = number
      row.updatedBy = entry.actor
      row.updatedAt = entry.at
      log(id, entry)
    },
  }
  return { store, rows, numbers }
}

export const VALID_CF = "RSSMRA80A01H501U"
export const OTHER_CF = "RSSMRA85T10A562S"

export const details = (overrides: Record<string, unknown> = {}) => ({
  firstName: "Mario",
  lastName: "Rossi",
  alias: "",
  codiceFiscale: VALID_CF,
  birthDate: "1980-01-01",
  birthPlace: "Roma",
  residence: { street: "Via Roma 1", postalCode: "20133", city: "Milano", province: "MI", country: "IT" },
  ...overrides,
})

export const admitInput = (overrides: Record<string, unknown> = {}): AdmitInput =>
  admitInputSchema.parse({
    account: { firstName: "Mario", lastName: "Rossi", sendEmailTo: "mario@example.org" },
    number: 344,
    details: details(),
    admittedOn: "2026-11-09",
    ...overrides,
  })

export const registerInput = (entraObjectId: string, overrides: Record<string, unknown> = {}): RegisterInput =>
  registerInputSchema.parse({
    entraObjectId,
    details: { firstName: "Alan", lastName: "Turing" },
    admittedOn: "2025-03-14",
    ...overrides,
  })

/** The service over the seeded mock directory (Ada 1001 and Alan 1002 in Soci, Grace outside it). */
export function harness(overrides: Partial<SociOptions> = {}) {
  const memory = memoryStore()
  const directory: AzureDirectory = createMockAzureDirectory()
  let tail: Promise<unknown> = Promise.resolve()
  const welcome = vi.fn().mockResolvedValue(true)
  const numberChanged = vi.fn().mockResolvedValue(true)
  const logger = { info: vi.fn(), error: vi.fn() }
  const service = createSociService({
    store: memory.store,
    directory,
    writes: {
      serialize(task) {
        const run = tail.then(task, task)
        tail = run.catch(() => undefined)
        return run
      },
      numberHolder: (n) => directory.findByMemberNumber(n),
      currentMember: (id) => directory.getMember(id),
      rememberNumber: () => {},
    },
    mail: { welcome, numberChanged },
    logger,
    now: () => new Date("2026-11-09T10:00:00Z"),
    ...overrides,
  })
  return { service, directory, ...memory, welcome, numberChanged, logger }
}
