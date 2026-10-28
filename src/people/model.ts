import { createHash, randomUUID } from "node:crypto"
import { TRPCError } from "@trpc/server"
import * as C from "./contract"
import type { MailAction, Officer, PeopleConfig, PeopleState, Person, StoredReceipt, UnitOfWork, Viewer } from "./types"

export function fail(
  code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED",
  message: string
): never {
  throw new TRPCError({ code, message })
}
export const nameOf = (p: Person) => `${p.profile.firstName} ${p.profile.lastName}`
export const ref = (p: Person) => ({ id: p.id, name: nameOf(p) })
export const newestReceipts = (a: { number: string }, b: { number: string }) =>
  Number(b.number.split("/")[0]) - Number(a.number.split("/")[0]) ||
  Number(b.number.split("/")[1]) - Number(a.number.split("/")[1])
export const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex")
export const today = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
export function academicYear(date: string) {
  const y = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 9 ? 1 : 0)
  return `${y}/${String(y + 1).slice(-2)}`
}
/** A `YYYY-MM-DD` date as Italian emails write it, e.g. "31 ottobre 2026". */
export const longDate = (date: string) =>
  new Intl.DateTimeFormat("it-IT", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(`${date}T00:00:00Z`)
  )
export const dueDate = (year: string) => `${year.slice(0, 4)}-10-31`
export function find(state: PeopleState, id: string) {
  return state.persons[id] ?? fail("NOT_FOUND", "Person not found")
}
export function own(state: PeopleState, viewer: Viewer) {
  return Object.values(state.persons).find((p) => p.accountSub === viewer.sub && p.account.status === "linked") ?? null
}
export const general = (v: Viewer, permission: string) => v.can("admin:access") && v.can(permission)
export function requireGeneral(v: Viewer, permission: string) {
  if (!general(v, permission)) fail("FORBIDDEN", `Missing ${permission} or admin:access`)
}
export function requireSelf(v: Viewer) {
  if (!v.can("people:self")) fail("FORBIDDEN", "Missing people:self")
}
export function requireOwn(s: PeopleState, v: Viewer) {
  requireSelf(v)
  return own(s, v) ?? fail("FORBIDDEN", "Confirm your account link first")
}
export function leads(p: Pick<Person, "teams"> | null, team?: C.TeamId) {
  return p?.teams.filter((m) => !m.endedOn && m.role === "lead" && (!team || m.team === team)).map((m) => m.team) ?? []
}
export function teamAccess(s: PeopleState, v: Viewer, team: C.TeamId, write: boolean) {
  if (general(v, write ? "people:write" : "people:read")) return
  if (!v.can("people:self") || !leads(own(s, v), team).length) fail("FORBIDDEN", "You do not lead this team")
}
export function log(p: Person, actor: string, text: string, now: Date) {
  p.activity.unshift({ actor, text, at: now.toISOString() })
}
export function fee(p: Person, config: PeopleConfig, date: string) {
  if (!p.member || p.member.status === "former") return null
  const year = academicYear(date)
  p.feeYears[year] ??= {
    year,
    status: "due",
    amountCents: config.feeCents,
    dueOn: dueDate(year),
    upload: null,
    rejection: null,
    payment: null,
    lastReminder: null,
    rejections: [],
    fileId: null,
  }
  const f = p.feeYears[year]
  if (f.status === "due" || f.status === "unpaid") f.status = date > f.dueOn ? "unpaid" : "due"
  p.member.fee = f.status
  return f
}
export function row(
  s: PeopleState,
  p: Person,
  v: Viewer,
  config: PeopleConfig,
  date: string,
  scopedContacts = false
): C.PersonRow {
  fee(p, config, date)
  const self = own(s, v)?.id === p.id
  const contacts = self || general(v, "people:read") || scopedContacts
  return C.personRowSchema.parse({
    ...p,
    preliminary: p.authProvisional === true,
    profile: {
      ...p.profile,
      personalEmail: contacts ? p.profile.personalEmail : null,
      phone: contacts ? p.profile.phone : null,
    },
    member: self || general(v, "people:members:read") ? p.member : null,
    isMember: !!p.member && p.member.status !== "former",
    account: self || general(v, "people:read") ? p.account : { status: "none" },
  })
}
export function record(s: PeopleState, p: Person, v: Viewer, config: PeopleConfig, date: string): C.PersonRecord {
  const self = own(s, v)?.id === p.id
  const read = general(v, "people:read")
  return C.personRecordSchema.parse({
    ...row(s, p, v, config, date),
    notes: read ? p.notes : null,
    discrepancies: read ? p.discrepancies : [],
    activity: read
      ? p.activity
      : self
        ? p.activity.filter((a) => /fee|receipt|payment|consent|census/i.test(a.text))
        : [],
    fees:
      p.member && (self || general(v, "people:members:read"))
        ? {
            current: fee(p, config, date),
            receipts: Object.values(s.receipts)
              .filter((r) => r.person.id === p.id)
              .sort(newestReceipts)
              .map((r) => C.receiptSchema.parse(r)),
          }
        : null,
  })
}
export function newPerson(s: PeopleState, input: C.CreatePersonInput, date: string): Person {
  const sequence = (s.counters.person ?? 0) + 1
  if (sequence > 9999) fail("PRECONDITION_FAILED", "The admin's four-digit person ID space is exhausted")
  s.counters.person = sequence
  const p: Person = {
    id: `P-${String(sequence).padStart(4, "0")}`,
    profile: {
      firstName: input.firstName,
      lastName: input.lastName,
      personalEmail: input.personalEmail || null,
      course: input.course || "",
      year: input.year || "",
      campus: input.campus ?? null,
      phone: input.phone || null,
      telegramUsername: input.telegramUsername || null,
      telegramId: input.telegramId || null,
      otherAssociations: [],
      studentRepresentative: null,
    },
    member: null,
    admin: input.admin
      ? {
          status: "active",
          since: date,
          endedOn: null,
          endReason: null,
          availableAsCapo: false,
          capoOfReference: null,
          capoScope: null,
        }
      : null,
    teams: [],
    census: [],
    consents: { privacy: null, photo: null },
    account: { status: "none" },
    notes: null,
    discrepancies: [],
    activity: [],
    accountSub: null,
    azureId: null,
    feeYears: {},
    answers: {},
    reminders: {},
    invite: null,
  }
  s.persons[p.id] = p
  return p
}
export function office(s: PeopleState, v: Viewer, config: PeopleConfig): Officer | null {
  if (!general(v, "people:receipts:sign")) return null
  const p = own(s, v)
  if (!p) return null
  return config.officers.president === p.id
    ? "president"
    : config.officers.vicePresident === p.id
      ? "vicePresident"
      : null
}
export function receiptEligible(
  s: PeopleState,
  r: StoredReceipt,
  v: Viewer,
  config: PeopleConfig,
  requireEsign = true
) {
  return (
    r.status === "toSign" &&
    office(s, v, config) === r.signer &&
    config.officers[r.signer] === r.officerPersonId &&
    (!requireEsign || v.can("esign:sign"))
  )
}
export function findReceipt(s: PeopleState, id: string) {
  return s.receipts[id] ?? fail("NOT_FOUND", "Receipt not found")
}
export function queue(
  s: PeopleState,
  p: Person,
  id: string,
  to: string,
  subject: string,
  text: string,
  action: MailAction | null = null
) {
  if (s.outbox[id]?.status === "failed") {
    s.outbox[id].status = "pending"
    s.outbox[id].attemptedAt = null
    s.outbox[id].error = null
  }
  s.outbox[id] ??= {
    id,
    personId: p.id,
    to,
    subject,
    text,
    action,
    fileId: null,
    receiptId: null,
    status: "pending",
    attemptedAt: null,
    error: null,
  }
}
export async function filePayload(u: UnitOfWork, id: string) {
  const file = await u.getFile(id)
  if (!file) fail("NOT_FOUND", "File not found")
  return {
    fileName: file.fileName,
    contentType: file.contentType,
    base64: Buffer.from(file.content).toString("base64"),
  }
}
export const csvCell = (v: string) => `"${(/^[=+\-@\t\r]/.test(v) ? `'${v}` : v).replaceAll('"', '""')}"`
export function validateFields(team: C.TeamId, fields: C.TeamFields) {
  for (const [key, value] of Object.entries(fields)) {
    const spec = C.TEAMS[team].fields.find((f) => f.key === key)
    if (!spec || (spec.kind === "text" ? typeof value !== "string" : !Array.isArray(value)))
      fail("BAD_REQUEST", "Invalid team field")
    if (
      spec.kind === "multi" &&
      "options" in spec &&
      Array.isArray(value) &&
      value.some((v) => !(spec.options as readonly string[]).includes(v))
    )
      fail("BAD_REQUEST", "Invalid team option")
  }
}
export function newFileId() {
  return randomUUID()
}
