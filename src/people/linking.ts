import { randomUUID } from "node:crypto"
import type * as C from "./contract"
import { type Evidence, type Match, matchAccount, RecordIndex } from "./identity"
import { fail, log, ref } from "./model"
import type { RoleDirectory } from "./roles"
import type { Account, PeopleState, Person, StoredReview } from "./types"

/**
 * What a match between an account and a record leads to (admin docs/people/linking.md §4.3), and the state changes
 * every linking path shares. `identity.ts` decides who matches; this decides who may confirm it.
 */

/** What the account holder sees while a review about them is open. */
export type Shown = "record" | "notice" | "hidden"

export type Decision =
  | { action: "none" }
  /** Only for an account holding a People role, by a Microsoft 365 identity. */
  | { action: "link"; person: Person }
  /** "Is this you?": the account holder confirms. */
  | { action: "confirm"; person: Person; evidence: Evidence }
  | { action: "review"; kind: C.ReviewKind; person: Person; other: Person | null; message: string; shown: Shown }

/** Every login account in Auth's People directory; preliminary persons are records, not accounts. */
export const accountsOf = (directory: RoleDirectory): Account[] =>
  directory.users.filter((u) => !u.provisional).map(accountOf)

export const accountOf = (u: RoleDirectory["users"][number]): Account => ({
  sub: u.sub,
  name: u.name,
  email: u.email,
  verifiedEmail: u.verifiedEmail ?? null,
  azureId: u.azureId ?? null,
  telegramId: u.telegramId,
  telegramUsername: u.telegramUsername,
  holdsPeopleRole: u.roles.length > 0,
})

export const carriesRoles = (p: Person) => p.admin?.status === "active" || p.teams.some((t) => !t.endedOn)

const PROVED = {
  "microsoft-365": "Microsoft 365 account",
  email: "email address",
  telegram: "Telegram account",
} as const satisfies Partial<Record<Evidence, string>>

const lower = (value: string | null | undefined) => value?.trim().toLowerCase() || null

/** The verified address is the `@polinetwork.org` one Microsoft 365 gave this record, not one HR typed. */
const sameMicrosoft365Address = (p: Person, account: Account) => {
  const email = lower(account.verifiedEmail)
  return !!email?.endsWith("@polinetwork.org") && lower(p.member?.m365Email) === email
}

/** The outcome policy. Who may approve is enforced where the link is made: Auth for a preliminary person. */
export function decide(match: Match, account: Account): Decision {
  if (match.kind === "none") return { action: "none" }
  if (match.kind === "conflict")
    return {
      action: "review",
      kind: match.reason === "microsoft-365-conflict" ? "identity-match" : match.reason,
      person: match.person,
      other: match.other,
      message: {
        "two-records": "Several records use the same verified identity",
        "telegram-conflict": "Verified email and Telegram identity disagree",
        "microsoft-365-conflict":
          "The sign-in matches this record, but the record holds another Microsoft 365 account: HR must check before linking.",
      }[match.reason],
      shown: "notice",
    }
  const { person, evidence } = match
  const review = (kind: C.ReviewKind, message: string, shown: Shown): Decision => ({
    action: "review",
    kind,
    person,
    other: null,
    message,
    shown,
  })
  if (evidence === "name")
    return person.authProvisional
      ? review(
          "name-only",
          "Only the name matches. This may be a different person; a Master Admin must check before linking.",
          "hidden"
        )
      : review("name-only", "Name-only matches require HR review", "hidden")
  if (evidence === "username")
    return person.authProvisional
      ? review(
          "preliminary-link",
          "The signed-in Telegram username matches the one recorded for this person. Usernames can change hands; a Master Admin must check before linking.",
          "notice"
        )
      : review(
          "identity-match",
          "Only the Telegram username matches. Usernames can change hands; HR must check before linking.",
          "notice"
        )
  const proved = PROVED[evidence]
  if (person.authProvisional)
    return review(
      "preliminary-link",
      `The verified ${proved} matches this preliminary person. A Master Admin must approve the link.`,
      "record"
    )
  if (account.holdsPeopleRole) {
    if (evidence === "microsoft-365" || (evidence === "email" && sameMicrosoft365Address(person, account)))
      return { action: "link", person }
    return review(
      "identity-match",
      `This account holds a People role in Auth and its verified ${proved} matches this record. Contacts on records are typed by HR or imported, so HR must confirm before linking.`,
      "record"
    )
  }
  if (carriesRoles(person))
    return review(
      "identity-match",
      `The verified ${proved} matches this record, which carries roles: HR links it and Auth grants the roles.`,
      "record"
    )
  return { action: "confirm", person, evidence }
}

/** What matching reads from the register, computed once per pass over many accounts. */
export type MatchContext = { index: RecordIndex; rejected: Map<string, Set<string>> }

/** Indexes the records and, per account, the records it was told aren't theirs ("This isn't me", Decline). */
export function matchContext(s: PeopleState): MatchContext {
  const rejected = new Map<string, Set<string>>()
  for (const r of Object.values(s.reviews))
    for (const id of r.rejectedPersonIds) rejected.set(r.sub, (rejected.get(r.sub) ?? new Set()).add(id))
  return { index: new RecordIndex(Object.values(s.persons)), rejected }
}

/** The decision for an account against the whole register. */
export const decideFor = (s: PeopleState, account: Account, context = matchContext(s)) =>
  decide(matchAccount(context.index, account, context.rejected.get(account.sub) ?? new Set()), account)

/** Opens a review, or returns the open one for the same account, kind and record. */
export function openReview(
  s: PeopleState,
  account: Account,
  kind: C.ReviewKind,
  p: Person | null,
  message: string,
  since: string,
  shown: Shown = "hidden"
): StoredReview {
  const existing = Object.values(s.reviews).find(
    (r) => r.sub === account.sub && r.kind === kind && !r.resolved && (r.record?.id ?? null) === (p?.id ?? null)
  )
  if (existing) return existing
  const id = randomUUID()
  s.reviews[id] = {
    id,
    kind,
    since,
    account: { name: account.name, email: account.email ?? "", telegram: account.telegramId, via: "IdP" },
    record: p ? ref(p) : null,
    other: null,
    message,
    sub: account.sub,
    resolved: false,
    rejectedPersonIds: [],
    shown,
  }
  return s.reviews[id]
}

export function reviewFor(
  s: PeopleState,
  account: Account,
  decision: Extract<Decision, { action: "review" }>,
  since: string
) {
  const r = openReview(s, account, decision.kind, decision.person, decision.message, since, decision.shown)
  Object.assign(r, {
    other: decision.other ? ref(decision.other) : null,
    message: decision.message,
    shown: decision.shown,
  })
  return r
}

/**
 * Sets the record's account. Fails when the account belongs to another record or the record to another account.
 * A preliminary person is linked by Auth instead (`PeopleRoles.link`). Returns whether the record had no account.
 */
export function attachAccount(
  s: PeopleState,
  p: Person,
  account: Account,
  actor: string,
  how: string,
  at: { date: string; now: Date },
  via = "IdP"
) {
  if (Object.values(s.persons).some((other) => other.id !== p.id && other.accountSub === account.sub))
    fail("CONFLICT", "This account is already linked to another person")
  if (p.authProvisional) fail("FORBIDDEN", "A Master Admin must approve this preliminary Auth person through Linking")
  if (p.accountSub && p.accountSub !== account.sub) fail("CONFLICT", "Unlink the existing account first")
  const wasLinked = !!p.accountSub
  p.accountSub = account.sub
  p.account = { status: "linked", email: account.email ?? "", via, linkedOn: at.date, how, by: actor }
  p.invite = null
  log(p, actor, `Linked account ${account.sub}: ${how}`, at.now)
  return !wasLinked
}

/** What My area shows someone signed in without a linked record. Opens the review the policy asks for. */
export function signInState(
  s: PeopleState,
  account: Account,
  since: string
):
  | { state: "match"; person: Person; evidence: Evidence }
  | { state: "awaiting"; person: Person | null; review: StoredReview }
  | { state: "none" } {
  const decision = decideFor(s, account)
  if (decision.action === "confirm") return { state: "match", person: decision.person, evidence: decision.evidence }
  if (decision.action === "review") reviewFor(s, account, decision, since)
  const open = Object.values(s.reviews).filter(
    (r) => r.sub === account.sub && !r.resolved && (r.shown === "record" || r.shown === "notice")
  )
  if (!open.length) return { state: "none" }
  const [only] = open
  const person = open.length === 1 && only.shown === "record" && only.record ? s.persons[only.record.id] : null
  return { state: "awaiting", person: person ?? null, review: only }
}

/** The sentence My area shows while a review about the account holder is open. */
export function awaitingReason(review: StoredReview, person: Person | null) {
  if (!person)
    return "An admin is checking whether you're already on PoliNetwork's lists. You don't need to ask to be added."
  const approver = review.kind === "preliminary-link" ? "A Master Admin" : "HR"
  return `Your verified sign-in matches this record. ${approver} will confirm the link: you don't need to ask to be added.`
}

/**
 * Preliminary persons wait for someone to sign in, who may never open My area: every account not linked yet is
 * matched against them when Auth's directory changes, and reviews that no longer apply are closed.
 */
export function reconcilePreliminary(s: PeopleState, accounts: Account[], since: string) {
  const persons = Object.values(s.persons)
  const open = Object.values(s.reviews).filter(
    (r) => !r.resolved && (r.kind === "preliminary-link" || !!(r.record && s.persons[r.record.id]?.authProvisional))
  )
  if (!open.length && !persons.some((p) => p.authProvisional)) return
  const linked = new Set(persons.flatMap((p) => (p.accountSub && !p.authProvisional ? [p.accountSub] : [])))
  const context = matchContext(s)
  const decisions = new Map<string, Decision>()
  for (const account of accounts) {
    if (linked.has(account.sub)) continue
    const decision = decideFor(s, account, context)
    decisions.set(account.sub, decision)
    if (decision.action === "review" && decision.person.authProvisional) reviewFor(s, account, decision, since)
  }
  // Only reviews this matching opened: a correction request on a linked record is not one.
  for (const r of open) {
    const p = r.record ? s.persons[r.record.id] : undefined
    const decision = decisions.get(r.sub)
    if (decision?.action !== "review" || decision.kind !== r.kind || decision.person.id !== p?.id) r.resolved = true
  }
}
