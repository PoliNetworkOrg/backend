import { nameOf } from "./model"
import type { Account, Person } from "./types"

/**
 * The one rule for "is this account the same person as this record?" (admin docs/people/linking.md §4.2).
 * The account's evidence was verified by PoliNetwork Auth; the record's was declared by HR, a census or a preliminary
 * person, except the Microsoft 365 identity. Nothing here links anything: `linking.ts` decides what a match leads to.
 */

/** What both sides share, strongest first. `microsoft-365` and `email` include the `@polinetwork.org` address. */
export type Evidence = "microsoft-365" | "email" | "telegram" | "username" | "name"
export type Strength = "verified" | "username" | "name"

export type Match =
  | { kind: "none" }
  | { kind: "one"; person: Person; evidence: Evidence; strength: Strength }
  /** Several records claim the verified identity, or the record's Telegram account is someone else's. */
  | { kind: "conflict"; reason: "two-records" | "telegram-conflict"; person: Person; other: Person | null }

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
  if (lower(nameOf(p)) === lower(account.name)) return "name"
  return null
}

/**
 * Matches an account against the records that could be theirs: not linked to an account yet, or preliminary Auth
 * persons waiting for one. The first tier with a hit decides. Only verified evidence can conflict: an ambiguous
 * username or name proves nothing, so it matches nobody.
 */
export function matchAccount(persons: Iterable<Person>, account: Account, rejected: ReadonlySet<string>): Match {
  const hits = [...persons].flatMap((p) => {
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
    if (only.person.profile.telegramId && account.telegramId && only.person.profile.telegramId !== account.telegramId)
      return { kind: "conflict", reason: "telegram-conflict", person: only.person, other: null }
    return { kind: "one", ...only }
  }
  return { kind: "none" }
}
