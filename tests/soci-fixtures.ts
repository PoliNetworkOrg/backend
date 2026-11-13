import { vi } from "vitest"
import { createMockAzureDirectory } from "@/azure/mock-directory"
import type { AzureDirectory } from "@/azure/types"
import type { AdmitInput, RegisterInput } from "@/soci/contract"
import { admitInputSchema, registerInputSchema } from "@/soci/contract"
import { createSociService, type SociOptions } from "@/soci/service"
import type { ActivityEntry, NewMail, SociMail, Socio, SociStore, StoredFee, StoredFile } from "@/soci/types"

/** The register in memory, with the same rules the tables enforce. */
export function memoryStore() {
  const rows: Socio[] = []
  const numbers = new Map<number, number>()
  const history = new Map<number, ActivityEntry[]>()
  const fees: StoredFee[] = []
  const files = new Map<string, StoredFile>()
  const outbox = new Map<string, SociMail>()
  const queue = (memberId: number, m: NewMail, at: string) => {
    if (outbox.has(m.id)) return false
    outbox.set(m.id, {
      ...structuredClone(m),
      memberId,
      status: "pending",
      createdAt: at,
      attemptedAt: null,
      error: null,
    })
    return true
  }
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
    async insert(socio, entry, firstFees = []) {
      if (numbers.has(socio.number)) throw new Error("duplicate key soci_numbers_pkey")
      if (rows.some((r) => r.entraObjectId === socio.entraObjectId)) throw new Error("duplicate entra_object_id")
      if (socio.codiceFiscale && rows.some((r) => r.codiceFiscale === socio.codiceFiscale && !r.endedOn))
        throw new Error("duplicate soci_members_active_codice_fiscale_idx")
      const row = { ...structuredClone(socio), id: rows.length + 1 }
      rows.push(row)
      numbers.set(row.number, row.id)
      log(row.id, entry)
      for (const f of firstFees) fees.push({ ...structuredClone(f), id: fees.length + 1, memberId: row.id })
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

    async fees(filter) {
      return structuredClone(
        fees
          .filter(
            (f) =>
              (filter.memberId === undefined || f.memberId === filter.memberId) &&
              (filter.year === undefined || f.year === filter.year)
          )
          .sort((a, b) => b.year - a.year || a.memberId - b.memberId)
      )
    },
    async openFee(memberId, fee, entry, m) {
      if (fees.some((f) => f.memberId === memberId && f.year === fee.year)) return null
      const row = { ...structuredClone(fee), id: fees.length + 1, memberId }
      fees.push(row)
      log(memberId, entry)
      if (m) queue(memberId, m, entry.at)
      return structuredClone(row)
    },
    async updateFee(fee, from, changes, entry, m, file) {
      const row = fees.find((f) => f.id === fee.id)
      if (!row || !from.includes(row.status)) return false
      if (fee.fileId !== undefined && row.fileId !== fee.fileId) return false
      if (file) files.set(file.id, structuredClone(file))
      Object.assign(row, structuredClone(changes))
      log(fee.memberId, entry)
      if (m) queue(fee.memberId, m, entry.at)
      return true
    },
    async file(id) {
      return structuredClone(files.get(id) ?? null)
    },
    async fileNames(ids) {
      return new Map(
        ids.flatMap((id) => {
          const f = files.get(id)
          return f ? [[id, { fileName: f.fileName, contentType: f.contentType }] as const] : []
        })
      )
    },
    async enqueue(memberId, m, at) {
      return queue(memberId, m, at)
    },
    async claimMail(at, staleBefore, limit) {
      for (const m of outbox.values())
        if (m.status === "sending" && m.attemptedAt && m.attemptedAt < staleBefore) {
          m.status = "failed"
          m.error = "Delivery outcome unknown after an interruption: check before resending."
        }
      const claimed = [...outbox.values()].filter((m) => m.status === "pending").slice(0, limit)
      for (const m of claimed) {
        m.status = "sending"
        m.attemptedAt = at
      }
      return structuredClone(claimed)
    },
    async finishMail(m, error, at) {
      const current = outbox.get(m.id)
      if (!current || current.status !== "sending" || current.attemptedAt !== m.attemptedAt) return
      current.status = error ? "failed" : "sent"
      current.error = error
      log(m.memberId, {
        actor: "system",
        text: error ? `The ${m.kind} email failed: ${error}` : `Sent the ${m.kind} email`,
        at,
      })
    },
  }
  return { store, rows, numbers, fees, files, outbox, history }
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
  residence: "Via Roma 1, 20133 Milano (MI)",
  phone: "",
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
  const send = vi.fn().mockResolvedValue(undefined)
  let clock = new Date("2026-11-09T10:00:00Z")
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
    fees: {
      bank: { iban: "IT60X0542811101000000123456", beneficiary: "PoliNetwork APS" },
      myAreaUrl: "https://admin.example.org/dashboard/account/me",
      send,
    },
    now: () => clock,
    ...overrides,
  })
  /** Moves the clock: an ISO instant, or a day in Rome at 08:00. */
  const setNow = (at: string) => {
    clock = new Date(at.length === 10 ? `${at}T07:00:00Z` : at)
  }
  return { service, directory, ...memory, welcome, numberChanged, logger, send, setNow }
}
