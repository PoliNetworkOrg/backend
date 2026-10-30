import { createHash } from "node:crypto"
import { TRPCError } from "@trpc/server"
import * as C from "./contract"
import type { PeopleState, Person, Viewer } from "./types"

export function fail(
  code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED",
  message: string
): never {
  throw new TRPCError({ code, message })
}
export const nameOf = (p: Person) => `${p.profile.firstName} ${p.profile.lastName}`
export const ref = (p: Person) => ({ id: p.id, name: nameOf(p) })
export const hash = (v: Uint8Array | string) => createHash("sha256").update(v).digest("hex")
export const today = (now: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now)
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
export function leads(p: Person | null, team?: C.TeamId) {
  return p?.teams.filter((m) => !m.endedOn && m.role === "lead" && (!team || m.team === team)).map((m) => m.team) ?? []
}
export function teamAccess(s: PeopleState, v: Viewer, team: C.TeamId, write: boolean) {
  if (general(v, write ? "people:write" : "people:read")) return
  if (!v.can("people:self") || !leads(own(s, v), team).length) fail("FORBIDDEN", "You do not lead this team")
}
export function log(p: Person, actor: string, text: string, now: Date) {
  p.activity.unshift({ actor, text, at: now.toISOString() })
}
export function row(s: PeopleState, p: Person, v: Viewer, scopedContacts = false): C.PersonRow {
  const self = own(s, v)?.id === p.id
  const contacts = self || general(v, "people:read") || scopedContacts
  return C.personRowSchema.parse({
    ...p,
    profile: {
      ...p.profile,
      personalEmail: contacts ? p.profile.personalEmail : null,
      phone: contacts ? p.profile.phone : null,
    },
    account: self || general(v, "people:read") ? p.account : { status: "none" },
  })
}
export function record(s: PeopleState, p: Person, v: Viewer): C.PersonRecord {
  const read = general(v, "people:read")
  return C.personRecordSchema.parse({
    ...row(s, p, v),
    notes: read ? p.notes : null,
    discrepancies: read ? p.discrepancies : [],
    activity: read ? p.activity : [],
  })
}
export function newPerson(s: PeopleState, input: C.CreatePersonInput, date: string): Person {
  const sequence = (s.counters.person ?? 0) + 1
  if (sequence > 9999) fail("PRECONDITION_FAILED", "The admin's four-digit person ID space is exhausted")
  s.counters.person = sequence
  const p: Person = {
    id: `P-${String(sequence).padStart(4, "0")}`,
    profile: {
      ...input,
      phone: input.phone || null,
      telegramUsername: input.telegramUsername || null,
      telegramId: null,
      otherAssociations: [],
      studentRepresentative: null,
    },
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
    consents: { privacy: null, photo: null },
    account: { status: "none" },
    notes: null,
    discrepancies: [],
    activity: [],
    accountSub: null,
    invite: null,
  }
  s.persons[p.id] = p
  return p
}
export function queue(s: PeopleState, p: Person, id: string, to: string, subject: string, text: string) {
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
    status: "pending",
    attemptedAt: null,
    error: null,
  }
}
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
