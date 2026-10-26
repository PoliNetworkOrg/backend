import { fail, leads, log, requireGeneral } from "./model"
import type { PeopleConfig, PeopleState, Person, Viewer } from "./types"

/** Merge reviewed duplicates; the caller archives the complete second record in the resolved review. */
export function mergePeople(
  s: PeopleState,
  first: Person,
  second: Person,
  viewer: Viewer,
  config: PeopleConfig,
  now: Date
): Person {
  if (first.id === second.id) fail("CONFLICT", "Choose two different records")
  if (Object.values(config.officers).includes(second.id))
    fail("PRECONDITION_FAILED", "Retain the configured officer's record when merging")
  if (first.member && second.member)
    fail("CONFLICT", "Both records have memberships; resolve the register conflict before merging")
  if (first.profile.telegramId && second.profile.telegramId && first.profile.telegramId !== second.profile.telegramId)
    fail("CONFLICT", "Resolve the Telegram identity conflict before merging")
  if (leads(first).length || leads(second).length || first.admin?.capoScope || second.admin?.capoScope)
    requireGeneral(viewer, "people:appoint")
  if (first.admin?.capoScope && second.admin?.capoScope && first.admin.capoScope !== second.admin.capoScope)
    fail("CONFLICT", "Resolve the Capo Admin scopes before merging")
  if (
    first.admin?.capoOfReference &&
    second.admin?.capoOfReference &&
    first.admin.capoOfReference.id !== second.admin.capoOfReference.id
  )
    fail("CONFLICT", "Resolve the Capo Admin references before merging")
  for (const other of second.teams) {
    const active = first.teams.find((t) => t.team === other.team && !t.endedOn && !other.endedOn)
    if (active) {
      if (JSON.stringify(active.fields) !== JSON.stringify(other.fields))
        fail("CONFLICT", "Resolve conflicting team fields before merging")
      if (other.since < active.since) active.since = other.since
      if (other.role === "lead") active.role = "lead"
    } else first.teams.push(structuredClone(other))
  }
  if (!first.admin) first.admin = structuredClone(second.admin)
  else if (second.admin) {
    if (second.admin.status === "active") first.admin.status = "active"
    if (first.admin.status === "active") {
      first.admin.endedOn = null
      first.admin.endReason = null
    }
    first.admin.since = [first.admin.since, second.admin.since].sort()[0]
    first.admin.capoScope ??= second.admin.capoScope
    first.admin.capoOfReference ??= second.admin.capoOfReference
    first.admin.availableAsCapo ||= second.admin.availableAsCapo
    for (const g of second.admin.groups)
      if (!first.admin.groups.some((t) => t.chatId === g.chatId)) first.admin.groups.push(g)
    for (const g of second.admin.requested)
      if (!first.admin.requested.some((t) => t.chatId === g.chatId)) first.admin.requested.push(g)
  }
  first.profile.telegramId ??= second.profile.telegramId
  first.profile.phone ||= second.profile.phone
  first.profile.personalEmail ||= second.profile.personalEmail
  first.profile.telegramUsername ||= second.profile.telegramUsername
  first.profile.otherAssociations = [
    ...new Set([...first.profile.otherAssociations, ...second.profile.otherAssociations]),
  ]
  first.profile.studentRepresentative ||= second.profile.studentRepresentative
  if (!first.member) {
    first.member = structuredClone(second.member)
    first.azureId = second.azureId
    first.feeYears = structuredClone(second.feeYears)
  }
  first.accountSub ??= second.accountSub
  if (second.accountSub && first.account.status !== "linked") first.account = structuredClone(second.account)
  first.invite = null
  for (const entry of second.census) {
    const existing = first.census.find((e) => e.year === entry.year)
    if (!existing || !existing.answer || (entry.answeredOn ?? "") > (existing.answeredOn ?? "")) {
      first.census = [...first.census.filter((e) => e.year !== entry.year), structuredClone(entry)]
      first.answers[entry.year] = structuredClone(second.answers[entry.year] ?? [])
    } else if (entry.answer && existing.answer !== entry.answer && existing.answeredOn === entry.answeredOn)
      fail("CONFLICT", "Resolve conflicting census answers before merging")
  }
  if (
    second.consents.privacy &&
    (!first.consents.privacy || second.consents.privacy.acceptedOn > first.consents.privacy.acceptedOn)
  )
    first.consents.privacy = structuredClone(second.consents.privacy)
  const restrictive = { granted: 0, denied: 1, revoked: 2 }
  if (
    second.consents.photo &&
    (!first.consents.photo ||
      second.consents.photo.on > first.consents.photo.on ||
      (second.consents.photo.on === first.consents.photo.on &&
        restrictive[second.consents.photo.status] > restrictive[first.consents.photo.status]))
  )
    first.consents.photo = structuredClone(second.consents.photo)
  if (second.notes) first.notes = [first.notes, `${second.id}: ${second.notes}`].filter(Boolean).join("\n")
  first.activity = [...first.activity, ...second.activity].sort((a, b) => b.at.localeCompare(a.at))
  first.discrepancies.push(...second.discrepancies)
  first.pendingGroupRemovals = [...(first.pendingGroupRemovals ?? []), ...(second.pendingGroupRemovals ?? [])]
  for (const p of Object.values(s.persons))
    if (p.admin?.capoOfReference?.id === second.id)
      p.admin.capoOfReference = { id: first.id, name: `${first.profile.firstName} ${first.profile.lastName}` }
  for (const r of Object.values(s.receipts)) if (r.person.id === second.id) r.person.id = first.id
  for (const mail of Object.values(s.outbox)) if (mail.personId === second.id) mail.personId = first.id
  for (const r of Object.values(s.reviews)) {
    if (r.record?.id === second.id) r.record.id = first.id
    if (r.other?.id === second.id) r.other.id = first.id
  }
  delete s.persons[second.id]
  log(first, viewer.sub, `Merged duplicate ${second.id}; original retained in the linking review`, now)
  return first
}
