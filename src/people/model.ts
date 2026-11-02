import { createHash, randomUUID } from "node:crypto"
import { TRPCError } from "@trpc/server"
import * as C from "./contract"
import { type Concept, conceptOf } from "./roles"
import type { Activity, Assignment, Invite, PeopleState, Person, UnitOfWork, Viewer } from "./types"

export function fail(
  code: "BAD_REQUEST" | "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED",
  message: string
): never {
  throw new TRPCError({ code, message })
}
export const nameOf = (p: Person) => `${p.firstName} ${p.lastName}`
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
  return Object.values(state.persons).find((p) => p.accountSub === viewer.sub) ?? null
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
  return own(s, v) ?? fail("FORBIDDEN", "Your account is not linked to a People record")
}

const order = (a: Assignment) =>
  [a.since, C.ASSIGNMENT_KINDS.indexOf(a.kind), a.team ?? "", a.endedOn ?? "9999-12-31", a.id].join("|")
/** A person's assignments, oldest first; on the same day admin, then Capo Admin, then teams, ended ones first. */
export function assignmentsOf(s: PeopleState, personId: string) {
  return Object.values(s.assignments)
    .filter((a) => a.personId === personId)
    .sort((a, b) => order(a).localeCompare(order(b)))
}
/** The current assignment of a concept: shown as current, even while Auth hasn't confirmed it. */
export function current(s: PeopleState, personId: string, concept: Concept) {
  return assignmentsOf(s, personId).find((a) => !a.endedOn && conceptOf(a) === concept) ?? null
}
/** Current and in effect: not a start still waiting for Auth. */
export const confirmed = (a: Assignment) => !a.endedOn && !(a.change === "start" && a.status === "sent")
export function confirmedOf(s: PeopleState, personId: string, concept: Concept) {
  const a = current(s, personId, concept)
  return a && confirmed(a) ? a : null
}
/** Teams the person leads, as far as People knows. Authorization reads Auth instead. */
export function leadsOf(s: PeopleState, personId: string) {
  return assignmentsOf(s, personId).flatMap((a) =>
    a.kind === "team" && a.teamRole === "lead" && confirmed(a) ? [a.team as C.TeamId] : []
  )
}
/** Whether a change for the person waits for Auth: a new one could be applied before it. */
export const waiting = (s: PeopleState, personId: string) =>
  Object.values(s.commands).some((c) => c.personId === personId && c.status === "queued")

export function log(u: UnitOfWork, personId: string, actor: string, text: string, now: Date) {
  u.activity.push({ personId, actor, text, at: now.toISOString() })
}
/** Once a Capo Admin's appointment has ended, the admins who had them as reference have none. */
export function clearCapoReferences(u: UnitOfWork, capoId: string, actor: string, now: Date) {
  for (const a of Object.values(u.state.assignments)) {
    if (a.kind !== "admin" || a.endedOn || a.capoOfReferenceId !== capoId) continue
    a.capoOfReferenceId = null
    log(u, a.personId, actor, `Their Capo Admin of reference, ${capoId}, ended`, now)
  }
}

const blank = (value: string) => value.trim() || null
/**
 * Allocates the next `P-0000` ID, or null once the four digits are used up. The `person` counter only moves
 * forward, so the ID of a record merged into another is never given again.
 */
export function nextPersonId(s: PeopleState) {
  const sequence = Math.max(s.counters.person ?? 0, ...Object.keys(s.persons).map((id) => Number(id.slice(2)))) + 1
  if (sequence > 9999) return null
  s.counters.person = sequence
  return `P-${String(sequence).padStart(4, "0")}`
}
export function newPerson(s: PeopleState, input: C.PersonInput, actor: string, now: Date): Person {
  const at = now.toISOString()
  const p: Person = {
    id: nextPersonId(s) ?? fail("PRECONDITION_FAILED", "The four-digit person ID space is exhausted"),
    firstName: input.firstName,
    lastName: input.lastName,
    contactEmail: blank(input.contactEmail),
    phone: blank(input.phone),
    telegramUsername: blank(input.telegramUsername),
    notes: null,
    accountSub: null,
    linkedAt: null,
    linkedBy: null,
    linkMethod: null,
    createdBy: actor,
    createdAt: at,
    updatedBy: actor,
    updatedAt: at,
  }
  s.persons[p.id] = p
  return p
}
export function touch(p: Person, actor: string, now: Date) {
  p.updatedBy = actor
  p.updatedAt = now.toISOString()
}

export function newAssignment(
  s: PeopleState,
  fields: Pick<Assignment, "personId" | "kind" | "since" | "assignedBy" | "status"> & Partial<Assignment>
): Assignment {
  const a: Assignment = {
    id: randomUUID(),
    team: null,
    teamRole: null,
    capoScope: null,
    capoOfReferenceId: null,
    fields: {},
    endedOn: null,
    endReason: null,
    change: "start",
    refusal: null,
    commandId: null,
    ...fields,
  }
  s.assignments[a.id] = a
  return a
}

export function queueMail(s: PeopleState, personId: string, id: string, to: string, subject: string, text: string) {
  if (s.mail[id]?.status === "failed") Object.assign(s.mail[id], { status: "pending", attemptedAt: null, error: null })
  s.mail[id] ??= { id, personId, to, subject, text, status: "pending", attemptedAt: null, error: null }
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

/** The person's open invite: not revoked, accepted or superseded. */
export function openInvite(s: PeopleState, personId: string): Invite | null {
  return (
    Object.values(s.invites)
      .filter((i) => i.personId === personId && !i.revokedAt && !i.acceptedAt)
      .sort((a, b) => (a.sentAt < b.sentAt ? 1 : -1))[0] ?? null
  )
}

function account(s: PeopleState, p: Person): C.Account {
  if (p.accountSub)
    return {
      status: "linked",
      sub: p.accountSub,
      method: p.linkMethod ?? "manual",
      linkedOn: p.linkedAt?.slice(0, 10) ?? null,
      linkedBy: p.linkedBy,
    }
  const invite = openInvite(s, p.id)
  return invite
    ? {
        status: "invite",
        email: invite.email,
        sentOn: invite.sentAt.slice(0, 10),
        expiresOn: invite.expiresAt.slice(0, 10),
        sentBy: invite.sentBy,
      }
    : { status: "none" }
}

export function assignmentView(s: PeopleState, a: Assignment): C.Assignment {
  const capo = a.capoOfReferenceId ? s.persons[a.capoOfReferenceId] : null
  return {
    id: a.id,
    kind: a.kind,
    team: a.team,
    teamRole: a.teamRole,
    capoScope: a.capoScope,
    capoOfReference: capo ? ref(capo) : null,
    fields: a.fields,
    since: a.since,
    endedOn: a.endedOn,
    endReason: a.endReason,
    assignedBy: a.assignedBy,
    change: a.change,
    status: a.status,
    refusal: a.refusal,
  }
}

export function row(s: PeopleState, p: Person, v: Viewer, scopedContacts = false): C.PersonRow {
  const self = !!p.accountSub && p.accountSub === v.sub
  const read = general(v, "people:read")
  const contacts = self || read || scopedContacts
  return C.personRowSchema.parse({
    id: p.id,
    firstName: p.firstName,
    lastName: p.lastName,
    contactEmail: contacts ? p.contactEmail : null,
    phone: contacts ? p.phone : null,
    telegramUsername: p.telegramUsername,
    account: self || read ? account(s, p) : { status: "none" },
    assignments: assignmentsOf(s, p.id).map((a) => assignmentView(s, a)),
  })
}
export function record(s: PeopleState, p: Person, v: Viewer, activity: Activity[]): C.PersonRecord {
  const read = general(v, "people:read")
  return C.personRecordSchema.parse({
    ...row(s, p, v),
    notes: read ? p.notes : null,
    activity: read ? activity.map(({ actor, text, at }) => ({ actor, text, at })) : [],
    createdBy: p.createdBy,
    createdAt: p.createdAt,
    updatedBy: p.updatedBy,
    updatedAt: p.updatedAt,
  })
}
