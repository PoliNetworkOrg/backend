import { nameOf } from "./model"
import type { Account, Person } from "./types"

/**
 * The one rule for "is this account the same person as this record?" (admin docs/people/linking.md §4.2).
 * The account's evidence was verified by PoliNetwork Auth; the record's was declared by HR, a census or a preliminary
 * person, except the Microsoft 365 identity. Nothing here links anything: `linking.ts` decides what a match leads to.
 */

/** What both sides share, strongest first. `email` is the personal or the Microsoft 365 address. */
export type Evidence = "microsoft-365" | "email" | "telegram" | "username" | "name"
export type Strength = "verified" | "username" | "name"

export type Match =
  | { kind: "none" }
  | { kind: "one"; person: Person; evidence: Evidence; strength: Strength }
  /**
   * Several records claim the verified identity, the record's Telegram account is someone else's, or the record holds
   * another Microsoft 365 account.
   */
  | {
      kind: "conflict"
      reason: "two-records" | "telegram-conflict" | "microsoft-365-conflict"
      person: Person
      other: Person | null
    }

const lower = (value: string | null | undefined) => value?.trim().toLowerCase() || null
const username = (value: string | null | undefined) => lower(value)?.replace(/^@/, "") || null

export const strengthOf = (evidence: Evidence): Strength =>
  evidence === "username" || evidence === "name" ? evidence : "verified"

/** The strongest evidence linking `account` to `p`, or null. */
export function evidenceBetween(p: Person, account: Account): Evidence | null {
  if (account.azureId && p.azureId === account.azureId) return "microsoft-365"
  const email = lower(account.verifiedEmail)
  if (email && (lower(p.profile.personalEmail) === email || lower(p.member?.m365Email) === email)) return "email"
  if (account.telegramId && p.profile.telegramId === account.telegramId) return "telegram"
  const handle = username(account.telegramUsername)
  if (handle && username(p.profile.telegramUsername) === handle) return "username"
  const name = lower(account.name)
  if (name && lower(nameOf(p)) === name) return "name"
  return null
}

/**
 * Records by every key `evidenceBetween` compares, so matching an account costs a few lookups instead of a pass over
 * the register. Built once per pass; `add` a record again after changing its identities.
 */
export class RecordIndex {
  private readonly keys = new Map<string, Set<Person>>()
  constructor(persons: Iterable<Person>) {
    for (const p of persons) this.add(p)
  }
  add(p: Person) {
    for (const key of [
      p.azureId && `azure:${p.azureId}`,
      lower(p.profile.personalEmail) && `email:${lower(p.profile.personalEmail)}`,
      lower(p.member?.m365Email) && `email:${lower(p.member?.m365Email)}`,
      p.profile.telegramId && `telegram:${p.profile.telegramId}`,
      username(p.profile.telegramUsername) && `username:${username(p.profile.telegramUsername)}`,
      lower(nameOf(p)) && `name:${lower(nameOf(p))}`,
    ])
      if (key) this.keys.set(key, (this.keys.get(key) ?? new Set()).add(p))
  }
  /** Records sharing at least one key with the account; `evidenceBetween` says how strongly. */
  candidates(account: Account): Set<Person> {
    const found = new Set<Person>()
    for (const key of [
      account.azureId && `azure:${account.azureId}`,
      lower(account.verifiedEmail) && `email:${lower(account.verifiedEmail)}`,
      account.telegramId && `telegram:${account.telegramId}`,
      username(account.telegramUsername) && `username:${username(account.telegramUsername)}`,
      lower(account.name) && `name:${lower(account.name)}`,
    ])
      for (const p of (key && this.keys.get(key)) || []) found.add(p)
    return found
  }
}

/** Whether `p` shares a verified identity with the account. */
export function sharesVerified(p: Person, account: Account) {
  const evidence = evidenceBetween(p, account)
  return !!evidence && strengthOf(evidence) === "verified"
}

/**
 * Matches an account against the records that could be theirs: not linked to an account yet, or preliminary Auth
 * persons waiting for one. The first tier with a hit decides. Only verified evidence can conflict: an ambiguous
 * username or name proves nothing, so it matches nobody.
 */
export function matchAccount(index: RecordIndex, account: Account, rejected: ReadonlySet<string>): Match {
  const hits = [...index.candidates(account)].flatMap((p) => {
    if ((p.accountSub && !p.authProvisional) || rejected.has(p.id)) return []
    const evidence = evidenceBetween(p, account)
    return evidence ? [{ person: p, evidence, strength: strengthOf(evidence) }] : []
  })
  for (const strength of ["verified", "username", "name"] as const) {
    const tier = hits.filter((hit) => hit.strength === strength)
    if (!tier.length) continue
    if (strength !== "verified") return tier.length === 1 ? { kind: "one", ...tier[0] } : { kind: "none" }
    if (tier.length > 1) {
      // One record has the address or Microsoft 365 identity, another the Telegram account.
      const byTelegram = tier.filter((hit) => hit.evidence === "telegram")
      const byOther = tier.filter((hit) => hit.evidence !== "telegram")
      if (byTelegram.length === 1 && byOther.length === 1)
        return { kind: "conflict", reason: "telegram-conflict", person: byOther[0].person, other: byTelegram[0].person }
      return { kind: "conflict", reason: "two-records", person: tier[0].person, other: tier[1].person }
    }
    const [only] = tier
    const { profile, azureId } = only.person
    if (profile.telegramId && account.telegramId && profile.telegramId !== account.telegramId)
      return { kind: "conflict", reason: "telegram-conflict", person: only.person, other: null }
    if (azureId && account.azureId && azureId !== account.azureId)
      return { kind: "conflict", reason: "microsoft-365-conflict", person: only.person, other: null }
    return { kind: "one", ...only }
  }
  return { kind: "none" }
}
