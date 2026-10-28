import * as C from "./contract"
import { evidenceBetween, strengthOf } from "./identity"
import { accountOf, attachAccount, decideFor, reviewFor } from "./linking"
import { academicYear, log, newPerson } from "./model"
import type { PeopleState, Person } from "./types"

/**
 * Roles in PoliNetwork Auth that Master Admin bound to People: `admin`, `team:<id>:member` or `team:<id>:lead`.
 * PoliNetwork Auth is the source of truth for who holds them; People mirrors them on each person's record and changes
 * them through `PeopleRoles.change`, which checks again what the acting dashboard user may do.
 */
export type RoleDirectory = {
  roles: { key: string; name: string; binding: string }[]
  users: {
    sub: string
    registrationId?: string
    provisional?: boolean
    previousSub?: string
    firstName?: string
    lastName?: string
    phone?: string | null
    declaredTelegramId?: string | null
    declaredTelegramUsername?: string | null
    name: string
    /** Contact address, for display. */
    email: string | null
    /** The address Auth verified; the only one People matches on. */
    verifiedEmail?: string | null
    azureId?: string | null
    telegramId: string | null
    telegramUsername: string | null
    /** Bound roles held, including through a parent role. */
    roles: string[]
    /** Those given directly, the only ones a change can take back; all of `roles` when absent. */
    assigned?: string[]
    /** When each held role was first given (`YYYY-MM-DD`), when Auth says. */
    since?: Record<string, string>
  }[]
}
export type RoleChange = {
  id: string
  actor: string
  sub: string
  reason: string
  changes: ({ kind: "admin"; active: boolean } | { kind: "team"; team: C.TeamId; role: "member" | "lead" | null })[]
}
export type RoleResult = { roles: RoleDirectory["roles"]; held: string[]; assigned: string[] }
export type CreateAuthPerson = {
  operation: "create-person"
  id: string
  actor: string
  firstName: string
  lastName: string
  email: string
  phone: string
  telegramId: string
  telegramUsername: string
  changes: RoleChange["changes"]
}
export type LinkAuthPerson = {
  operation: "link-person"
  id: string
  actor: string
  personId: string
  userId: string
  reason: string
}
export type UpdateAuthPerson = Omit<CreateAuthPerson, "operation" | "changes"> & {
  operation: "update-person"
  personId: string
}
export type PeopleRoles = {
  update?(input: UpdateAuthPerson): Promise<{ sub: string }>
  create?(input: CreateAuthPerson): Promise<{ sub: string }>
  link?(input: LinkAuthPerson): Promise<{ sub: string }>
  directory(): Promise<RoleDirectory>
  change(change: RoleChange): Promise<RoleResult>
}
/** A member of the Microsoft 365 Soci group. */
export type AzureMember = {
  id: string
  mail: string
  givenName: string | null
  surname: string | null
  displayName: string | null
  employeeId: string | null
  /** The account's creation date (`YYYY-MM-DD`), the best known admission date. */
  createdOn: string | null
}

/** PoliNetwork Auth refused or failed a role change; `status` is its HTTP status. */
export class RoleChangeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

type TeamRole = C.TeamMembership["role"]
export type Bound = { admin: string[]; teams: Record<C.TeamId, Record<TeamRole, string[]>> }
/** A person's active roles, as People shows them. */
export type RoleView = { admin: boolean; teams: Partial<Record<C.TeamId, TeamRole>> }

const isTeam = (value: string): value is C.TeamId => (C.TEAM_IDS as readonly string[]).includes(value)

/** Role keys by what they mean in People. Bindings to unknown teams are ignored. */
export function boundRoles(directory: RoleDirectory): Bound {
  const bound: Bound = {
    admin: [],
    teams: Object.fromEntries(
      C.TEAM_IDS.map((id) => [id, { member: [] as string[], lead: [] as string[] }])
    ) as Bound["teams"],
  }
  for (const role of directory.roles) {
    if (role.binding === "admin") bound.admin.push(role.key)
    const [kind, team, as] = role.binding.split(":")
    if (kind === "team" && isTeam(team) && (as === "member" || as === "lead")) bound.teams[team][as].push(role.key)
  }
  return bound
}

const teamBound = (bound: Bound, team: C.TeamId) => bound.teams[team].member.length + bound.teams[team].lead.length > 0

/** The roles PoliNetwork Auth says this account holds; a Lead role wins over a member one. */
export function wantedView(bound: Bound, held: readonly string[]): RoleView {
  const view: RoleView = { admin: bound.admin.some((key) => held.includes(key)), teams: {} }
  for (const team of C.TEAM_IDS) {
    if (bound.teams[team].lead.some((key) => held.includes(key))) view.teams[team] = "lead"
    else if (bound.teams[team].member.some((key) => held.includes(key))) view.teams[team] = "member"
  }
  return view
}

export function roleView(p: Pick<Person, "admin" | "teams">): RoleView {
  const view: RoleView = { admin: p.admin?.status === "active", teams: {} }
  for (const t of p.teams) if (!t.endedOn) view.teams[t.team] = t.role
  return view
}

/** Send desired organizational states; Auth chooses and validates the actual role assignments. */
export function roleChanges(before: RoleView, after: RoleView): RoleChange["changes"] {
  const changes: RoleChange["changes"] = []
  if (before.admin !== after.admin) changes.push({ kind: "admin", active: after.admin })
  for (const team of C.TEAM_IDS)
    if (before.teams[team] !== after.teams[team]) changes.push({ kind: "team", team, role: after.teams[team] ?? null })
  return changes
}

/** A record with only a name, for someone People hears of from PoliNetwork Auth or Microsoft 365. */
export function blankPerson(s: PeopleState, name: { first: string; last: string }, date: string) {
  const p = newPerson(
    s,
    {
      firstName: name.first,
      lastName: name.last,
      personalEmail: "",
      phone: "",
      telegramUsername: "",
      course: "",
      year: "Graduated",
      campus: "External",
      admin: false,
    },
    date
  )
  Object.assign(p.profile, { personalEmail: null, course: "", year: "", campus: null })
  return p
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return { first: parts.shift() ?? "", last: parts.join(" ") }
}

const lower = (value: string | null | undefined) => value?.trim().toLowerCase() || null

type Clock = { date: string; now: Date }
/** Asks HR to look at the record, once per distinct reason. */
export function flagForReview(p: Person, message: string) {
  if (!p.discrepancies.some((d) => d.message === message))
    p.discrepancies.push({ kind: "needs-review", message, suggestedTelegram: null })
}

/**
 * Mirrors PoliNetwork Auth's bound roles on People records:
 * - everyone holding one gets a record: theirs, one matched by `linking.ts` (linked automatically only by a
 *   Microsoft 365 identity, otherwise reviewed by HR), or a new one;
 * - on linked records, a bound role's entry starts when the role is held and ends when it was mirrored and is no
 *   longer held. Previously local entries on linked records also follow Auth.
 * Concepts with no bound role (for example a team nobody bound yet) stay owned by People.
 */
export function syncDirectory(s: PeopleState, directory: RoleDirectory, at: Clock) {
  const bound = boundRoles(directory)
  const persons = () => Object.values(s.persons)
  const users = new Map(directory.users.map((u) => [u.sub, u]))
  for (const u of directory.users) {
    const wanted = wantedView(bound, u.roles)
    const account = accountOf(u)
    const existing = persons().find(
      (p) => p.accountSub === u.sub || (u.registrationId && p.authRegistrationId === u.registrationId)
    )
    const holds = wanted.admin || Object.keys(wanted.teams).length > 0
    // Accounts without a bound role only refresh the identities of the record already linked to them.
    if (!existing && !u.registrationId && !holds) continue
    // Records other than its own holding this account's verified identity.
    const holders = persons().filter((other) => {
      if (other === existing || other.authProvisional || (!existing && !other.accountSub)) return false
      const evidence = evidenceBetween(other, account)
      return !!evidence && strengthOf(evidence) === "verified"
    })
    let p: Person
    // Never move an identity off the record holding it, or give it a second record: HR decides.
    if (holders.length || (existing?.azureId && u.azureId && existing.azureId !== u.azureId)) {
      for (const other of existing ? [existing, ...holders] : holders)
        flagForReview(
          other,
          `PoliNetwork Auth account ${u.sub} matches more than one record: check their account links.`
        )
      continue
    }
    if (existing) {
      p = existing
      if (p.account.status === "linked") p.account.email = u.email ?? p.account.email
    } else if (u.registrationId) {
      p = blankPerson(s, splitName(u.name), at.date)
      log(p, "system", "Created from a preliminary person in PoliNetwork Auth", at.now)
    } else {
      const decision = decideFor(s, account)
      if (decision.action === "review") {
        reviewFor(s, account, decision, at.date)
        continue
      }
      if (decision.action === "link") p = decision.person
      else {
        p = blankPerson(s, splitName(u.name), at.date)
        log(p, "system", "Created from a role held in PoliNetwork Auth", at.now)
      }
      attachAccount(s, p, account, "system", "Holds a People role in PoliNetwork Auth", at, "PoliNetwork Auth")
    }
    if (u.registrationId) {
      p.authRegistrationId = u.registrationId
      p.authProvisional = u.provisional === true
      p.accountSub = u.sub
      p.profile.firstName = u.firstName ?? p.profile.firstName
      p.profile.lastName = u.lastName ?? p.profile.lastName
      p.profile.phone = u.phone ?? null
      if (u.provisional) {
        p.account = { status: "none" }
        p.profile.personalEmail = u.email
        p.profile.telegramId = u.declaredTelegramId ?? null
        p.profile.telegramUsername = u.declaredTelegramUsername ?? null
      } else if (p.account.status !== "linked") {
        p.account = {
          status: "linked",
          email: u.email ?? "",
          via: "PoliNetwork Auth",
          linkedOn: at.date,
          how: "Master Admin approved the preliminary identity",
        }
      }
    }
    // Microsoft 365 members are matched by this ID, so a later PoliNetwork address doesn't make a second record.
    if (u.azureId) p.azureId = u.azureId
    if (!p.profile.telegramId && u.telegramId) p.profile.telegramId = u.telegramId
    p.profile.telegramUsername ||= u.telegramUsername
  }

  for (const p of persons()) {
    if (!p.accountSub || (p.account.status !== "linked" && !p.authProvisional) || p.roleCommand) continue
    const u = users.get(p.accountSub)
    syncPersonRoles(p, bound, wantedView(bound, u?.roles ?? []), at, u?.since)
  }
}

/** The earliest date Auth gave one of these roles, or today when it doesn't say. */
function sinceOf(keys: readonly string[], since: Record<string, string> | undefined, today: string) {
  return (
    keys
      .map((key) => since?.[key])
      .filter((d): d is string => !!d)
      .sort()[0] ?? today
  )
}

/**
 * For linked records Auth owns every bound concept, including previously local entries: an entry is active exactly
 * while its role is held, starting when Auth gave it.
 */
export function syncPersonRoles(p: Person, bound: Bound, wanted: RoleView, at: Clock, since?: Record<string, string>) {
  if (bound.admin.length) {
    if (wanted.admin && p.admin?.status !== "active") {
      p.admin = {
        availableAsCapo: false,
        capoOfReference: null,
        capoScope: null,
        ...p.admin,
        status: "active",
        since: sinceOf(bound.admin, since, at.date),
        endedOn: null,
        endReason: null,
      }
      log(p, "system", "Started admin role: held in PoliNetwork Auth", at.now)
    } else if (!wanted.admin && p.admin?.status === "active") {
      Object.assign(p.admin, {
        status: "former",
        endedOn: at.date,
        endReason: "Not held in PoliNetwork Auth",
        capoScope: null,
      })
      log(p, "system", "Ended admin role: not held in PoliNetwork Auth", at.now)
    }
  }
  for (const team of C.TEAM_IDS) {
    if (!teamBound(bound, team)) continue
    const role = wanted.teams[team]
    const active = p.teams.find((t) => t.team === team && !t.endedOn)
    if (role && !active) {
      p.teams.push({
        team,
        role,
        since: sinceOf(bound.teams[team][role], since, at.date),
        endedOn: null,
        endReason: null,
        fields: {},
      })
      log(p, "system", `Joined ${team} as ${role}: held in PoliNetwork Auth`, at.now)
    } else if (role && active && active.role !== role) {
      active.role = role
      log(p, "system", `Became ${role} of ${team}: held in PoliNetwork Auth`, at.now)
    } else if (!role && active) {
      Object.assign(active, { endedOn: at.date, endReason: "Not held in PoliNetwork Auth" })
      log(p, "system", `Ended ${team}: not held in PoliNetwork Auth`, at.now)
    }
  }
}

/** How long a member admitted from People may be missing from the Soci group listing before it counts. */
const ADMISSION_GRACE_DAYS = 2

const usableNumber = (employeeId: string | null) => {
  const digits = employeeId?.trim() ?? ""
  return { digits, number: /^\d{1,4}$/.test(digits) ? digits.padStart(4, "0") : null }
}

/**
 * Applies the Microsoft 365 Soci group, which decides who is a member and their number (`employeeId`):
 * - each group member is matched by Microsoft 365 account or address, or by the PoliNetwork address of a linked
 *   account, otherwise gets a new record, and takes the account's number;
 * - a member of the register who is no longer in the group becomes former, unless admitted in the last
 *   {@link ADMISSION_GRACE_DAYS} days, which the group listing may not show yet.
 * The register keeps only what Microsoft 365 doesn't: suspension or expiry, the admission date, fees and history.
 */
export function syncMembers(s: PeopleState, members: AzureMember[], at: Clock) {
  const persons = () => Object.values(s.persons)
  const inGroup = new Set<string>()
  for (const m of members) {
    const mail = lower(m.mail)
    if (!mail) continue
    const matches = persons().filter(
      (p) =>
        p.azureId === m.id ||
        lower(p.member?.m365Email) === mail ||
        (p.account.status === "linked" && lower(p.account.email) === mail)
    )
    if (matches.length > 1 || matches.some((p) => p.azureId && p.azureId !== m.id)) {
      for (const p of matches)
        flagForReview(p, "Microsoft 365 identities match conflicting People records; review the account links.")
      continue
    }
    const match = matches[0]
    const p =
      match ??
      blankPerson(
        s,
        m.givenName || m.surname
          ? { first: m.givenName?.trim() ?? "", last: m.surname?.trim() ?? "" }
          : splitName(m.displayName ?? mail.split("@")[0]),
        at.date
      )
    if (!match) log(p, "system", "Created from the Microsoft 365 Soci group", at.now)
    p.azureId ??= m.id
    inGroup.add(p.id)
    const { digits, number } = usableNumber(m.employeeId)
    if (!number || persons().some((other) => other !== p && other.member?.number === number)) {
      flagForReview(p, `In the Microsoft 365 Soci group without a usable member number (${digits || "none"})`)
      if (p.member) p.member.m365Email = m.mail
      continue
    }
    if (p.member) {
      if (p.member.number !== number) log(p, "system", `Member number ${number} in Microsoft 365`, at.now)
      if (p.member.status === "former") {
        p.member.status = "active"
        log(p, "system", "Back in the Microsoft 365 Soci group", at.now)
      }
      Object.assign(p.member, { number, m365Email: m.mail })
      continue
    }
    p.member = {
      number,
      status: "active",
      admittedOn: m.createdOn ?? at.date,
      fee: "due",
      m365Email: m.mail,
    }
    p.importedFeeYear = academicYear(at.date)
    log(
      p,
      "system",
      `Member ${number} in the Microsoft 365 Soci group${m.createdOn ? "; admission date taken from the account's creation" : ""}`,
      at.now
    )
  }

  const grace = new Date(at.now.getTime() - ADMISSION_GRACE_DAYS * 86_400_000).toISOString().slice(0, 10)
  for (const p of persons())
    if (p.member && p.member.status !== "former" && !inGroup.has(p.id) && p.member.admittedOn < grace) {
      p.member.status = "former"
      log(p, "system", "Not in the Microsoft 365 Soci group: no longer a member", at.now)
    }
}
