import { describe, expect, it } from "vitest"
import { type Evidence, matchAccount, strengthOf } from "@/people/identity"
import { decide } from "@/people/linking"
import { newPerson } from "@/people/model"
import { type Account, emptyState, type Person } from "@/people/types"
import { profile } from "./people-fixtures"

const register = emptyState()
/** A record without roles or account, with its own ID; `extra` adjusts it. */
function record(first: string, last: string, extra: (p: Person) => void = () => {}) {
  const p = newPerson(register, { ...profile(first, last), admin: false }, "2026-10-01")
  extra(p)
  return p
}
const account = (extra: Partial<Account> = {}): Account => ({
  sub: "login",
  name: "Someone Else",
  email: null,
  verifiedEmail: null,
  azureId: null,
  telegramId: null,
  telegramUsername: null,
  ...extra,
})
const none = new Set<string>()

describe("one identity rule", () => {
  const mario = record("Mario", "Rossi", (p) => {
    p.profile.telegramId = "101"
  })

  it.each([
    ["Microsoft 365 object ID", account({ azureId: "az-1" }), "microsoft-365"],
    ["verified personal email, any case", account({ verifiedEmail: "MARIO@example.org" }), "email"],
    ["Telegram ID", account({ telegramId: "101" }), "telegram"],
    ["Telegram username, with @ and any case", account({ telegramUsername: "@Mario_Test" }), "username"],
    ["full name", account({ name: "mario rossi" }), "name"],
  ])("matches by %s", (_, signedIn, evidence) => {
    const p = structuredClone(mario)
    p.azureId = "az-1"
    expect(matchAccount([p], signedIn, none)).toMatchObject({ kind: "one", evidence })
  })

  it("never matches on an address Auth did not verify", () => {
    expect(matchAccount([mario], account({ email: "mario@example.org" }), none)).toEqual({ kind: "none" })
  })

  it("matches the Microsoft 365 address of a member", () => {
    const member = record("Anna", "Bianchi", (p) => {
      p.member = {
        number: "0001",
        status: "active",
        admittedOn: "2025-01-01",
        fee: "due",
        m365Email: "a.b@polinetwork.org",
      }
    })
    expect(matchAccount([member], account({ verifiedEmail: "a.b@polinetwork.org" }), none)).toMatchObject({
      kind: "one",
      evidence: "email",
    })
  })

  it("prefers verified evidence over a username or name on other records", () => {
    const homonym = record("Mario", "Rossi")
    const handle = record("Luca", "Verdi", (p) => {
      p.profile.telegramUsername = "mario_test"
    })
    const match = matchAccount([homonym, handle, mario], account({ telegramId: "101", name: "Mario Rossi" }), none)
    expect(match).toMatchObject({ kind: "one", person: { id: mario.id }, evidence: "telegram" })
  })

  it("reports conflicting verified evidence and ignores ambiguous weak evidence", () => {
    const twin = record("Maria", "Rossi", (p) => {
      p.profile.personalEmail = "mario@example.org"
    })
    expect(matchAccount([mario, twin], account({ verifiedEmail: "mario@example.org" }), none)).toMatchObject({
      kind: "conflict",
      reason: "two-records",
    })
    const byEmail = record("Anna", "Bianchi")
    expect(
      matchAccount([byEmail, mario], account({ verifiedEmail: "anna@example.org", telegramId: "101" }), none)
    ).toMatchObject({
      kind: "conflict",
      reason: "telegram-conflict",
      person: { id: byEmail.id },
      other: { id: mario.id },
    })
    expect(
      matchAccount([mario], account({ verifiedEmail: "mario@example.org", telegramId: "999" }), none)
    ).toMatchObject({ kind: "conflict", reason: "telegram-conflict", other: null })
    expect(matchAccount([mario, record("Mario", "Rossi")], account({ name: "Mario Rossi" }), none)).toEqual({
      kind: "none",
    })
  })

  it("skips records linked to an account and records the account holder rejected", () => {
    const linked = record("Mario", "Rossi", (p) => {
      p.accountSub = "other"
      p.profile.telegramId = "101"
    })
    expect(matchAccount([linked], account({ telegramId: "101" }), none)).toEqual({ kind: "none" })
    expect(matchAccount([mario], account({ telegramId: "101" }), new Set([mario.id]))).toEqual({ kind: "none" })
    const preliminary = record("Mario", "Rossi", (p) => {
      p.accountSub = "people:1"
      p.authProvisional = true
      p.profile.telegramId = "101"
    })
    expect(matchAccount([preliminary], account({ telegramId: "101" }), none)).toMatchObject({ kind: "one" })
  })
})

describe("one outcome policy", () => {
  const one = (person: Person, evidence: Evidence) =>
    ({ kind: "one", person, evidence, strength: strengthOf(evidence) }) as const
  const plain = record("Mario", "Rossi")
  const withRoles = record("Mario", "Rossi", (p) => {
    p.teams.push({ team: "it", role: "member", since: "2026-01-01", endedOn: null, endReason: null, fields: {} })
  })
  const preliminary = record("Mario", "Rossi", (p) => {
    p.authProvisional = true
  })

  it.each([
    [
      "the account holder confirms a verified match on a record that grants nothing",
      plain,
      "email",
      {},
      { action: "confirm" },
    ],
    [
      "HR approves a verified match on a record that carries roles (D1)",
      withRoles,
      "email",
      {},
      { action: "review", kind: "identity-match", shown: "record" },
    ],
    [
      "a Master Admin approves a verified match on a preliminary person",
      preliminary,
      "telegram",
      {},
      { action: "review", kind: "preliminary-link", shown: "record" },
    ],
    [
      "a username on a preliminary person is shown as being checked",
      preliminary,
      "username",
      {},
      { action: "review", kind: "preliminary-link", shown: "notice" },
    ],
    [
      "a username on another record goes to HR",
      plain,
      "username",
      {},
      { action: "review", kind: "identity-match", shown: "notice" },
    ],
    ["a name alone is a hidden hint", plain, "name", {}, { action: "review", kind: "name-only", shown: "hidden" }],
    [
      "a role holder is linked by a Microsoft 365 identity",
      withRoles,
      "microsoft-365",
      { holdsPeopleRole: true },
      { action: "link" },
    ],
    [
      "a role holder is linked by a PoliNetwork address",
      plain,
      "email",
      { holdsPeopleRole: true, verifiedEmail: "m.r@polinetwork.org" },
      { action: "link" },
    ],
    [
      "a role holder's Telegram ID goes to HR (D2)",
      plain,
      "telegram",
      { holdsPeopleRole: true },
      { action: "review", kind: "identity-match" },
    ],
    [
      "a role holder's personal address goes to HR (D2)",
      plain,
      "email",
      { holdsPeopleRole: true, verifiedEmail: "m@gmail.com" },
      { action: "review", kind: "identity-match" },
    ],
  ] as const)("%s", (_, p, evidence, extra, expected) => {
    expect(decide(one(p, evidence), account(extra))).toMatchObject(expected)
  })

  it("reviews a conflict and tells the account holder it is being checked", () => {
    expect(
      decide({ kind: "conflict", reason: "two-records", person: plain, other: withRoles }, account())
    ).toMatchObject({ action: "review", kind: "two-records", other: { id: withRoles.id }, shown: "notice" })
  })
})
