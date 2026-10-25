import * as C from "./contract"
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
    name: string
    email: string | null
    telegramId: string | null
    telegramUsername: string | null
    roles: string[]
  }[]
}
export type RoleChange = { actor: string; sub: string; role: string; action: "assign" | "unassign"; reason: string }
export type PeopleRoles = {
  directory(): Promise<RoleDirectory>
  change(change: RoleChange): Promise<void>
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

export function roleView(p: Person): RoleView {
  const view: RoleView = { admin: p.admin?.status === "active", teams: {} }
  for (const t of p.teams) if (!t.endedOn) view.teams[t.team] = t.role
  return view
}

/**
 * The changes in PoliNetwork Auth that turn `before` into `after` for an account holding `held`. Ending a role takes
 * back every bound role behind it, Lead roles first so a refused Lead change leaves the membership untouched.
 */
export function roleChanges(
  bound: Bound,
  held: readonly string[],
  before: RoleView,
  after: RoleView
): { role: string; action: RoleChange["action"] }[] {
  const changes: { role: string; action: RoleChange["action"] }[] = []
  const holds = (keys: string[]) => keys.some((key) => held.includes(key))
  const take = (keys: string[]) => {
    for (const role of keys) if (held.includes(role)) changes.push({ role, action: "unassign" })
  }
  if (bound.admin.length && before.admin !== after.admin) {
    if (after.admin && !holds(bound.admin)) changes.push({ role: bound.admin[0], action: "assign" })
    if (!after.admin) take(bound.admin)
  }
  for (const team of C.TEAM_IDS) {
    const { member, lead } = bound.teams[team]
    const [was, now] = [before.teams[team], after.teams[team]]
    if (!teamBound(bound, team) || was === now) continue
    if (!now) {
      take(lead)
      take(member)
      continue
    }
    if (was === "lead") take(lead)
    const keys = now === "lead" && lead.length ? lead : member
    if (keys.length && !holds(keys)) changes.push({ role: keys[0], action: "assign" })
  }
  return changes
}

/** Records which of the person's active roles now mirror PoliNetwork Auth. */
export function markSynced(p: Person, bound: Bound, view: RoleView) {
  const teams = new Set(p.synced?.teams ?? [])
  let admin = !!p.synced?.admin
  if (bound.admin.length) admin = view.admin
  for (const team of C.TEAM_IDS) if (teamBound(bound, team)) view.teams[team] ? teams.add(team) : teams.delete(team)
  p.synced = { ...(admin ? { admin: true as const } : {}), ...(teams.size ? { teams: [...teams].sort() } : {}) }
  if (!p.synced.admin && !p.synced.teams) delete p.synced
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

/**
 * Mirrors PoliNetwork Auth's bound roles on People records:
 * - everyone holding one gets a record, found by account, then by Telegram ID or Microsoft 365 address, and linked;
 * - on linked records, a bound role's entry starts when the role is held and ends when it was mirrored and is no
 *   longer held. Entries People added itself (census, dashboard before linking) are left alone.
 * Concepts with no bound role (for example a team nobody bound yet) stay owned by People.
 */
export function syncDirectory(s: PeopleState, directory: RoleDirectory, at: Clock) {
  const bound = boundRoles(directory)
  const persons = () => Object.values(s.persons)
  const users = new Map(directory.users.map((u) => [u.sub, u]))
  for (const u of directory.users) {
    const wanted = wantedView(bound, u.roles)
    if (!wanted.admin && !Object.keys(wanted.teams).length) continue
    if (persons().some((p) => p.accountSub === u.sub)) continue
    const email = lower(u.email)
    const match =
      persons().find((p) => !p.accountSub && u.telegramId && p.profile.telegramId === u.telegramId) ??
      persons().find(
        (p) => !p.accountSub && email?.endsWith("@polinetwork.org") && lower(p.member?.m365Email) === email
      )
    const p = match ?? blankPerson(s, splitName(u.name), at.date)
    if (!match) log(p, "system", "Created from a role held in PoliNetwork Auth", at.now)
    p.accountSub = u.sub
    p.account = {
      status: "linked",
      email: u.email ?? "",
      via: "PoliNetwork Auth",
      linkedOn: at.date,
      how: "Holds a People role in PoliNetwork Auth",
    }
    p.invite = null
    if (!p.profile.telegramId && u.telegramId && !persons().some((other) => other.profile.telegramId === u.telegramId))
      p.profile.telegramId = u.telegramId
    p.profile.telegramUsername ||= u.telegramUsername
    log(p, "system", `Linked account ${u.sub}: holds a People role in PoliNetwork Auth`, at.now)
  }

  for (const p of persons()) {
    if (!p.accountSub || p.account.status !== "linked") continue
    const wanted = wantedView(bound, users.get(p.accountSub)?.roles ?? [])
    if (bound.admin.length) {
      if (wanted.admin && p.admin?.status !== "active") {
        p.admin = {
          groups: [],
          requested: [],
          availableAsCapo: false,
          capoOfReference: null,
          capoScope: null,
          ...p.admin,
          status: "active",
          since: at.date,
          endedOn: null,
          endReason: null,
        }
        log(p, "system", "Started admin role: held in PoliNetwork Auth", at.now)
      } else if (!wanted.admin && p.admin?.status === "active" && p.synced?.admin) {
        Object.assign(p.admin, {
          status: "former",
          endedOn: at.date,
          endReason: "Role taken back in PoliNetwork Auth",
          capoScope: null,
        })
        log(p, "system", "Ended admin role: taken back in PoliNetwork Auth", at.now)
      }
    }
    for (const team of C.TEAM_IDS) {
      if (!teamBound(bound, team)) continue
      const role = wanted.teams[team]
      const active = p.teams.find((t) => t.team === team && !t.endedOn)
      if (role && !active) {
        p.teams.push({ team, role, since: at.date, endedOn: null, endReason: null, fields: {} })
        log(p, "system", `Joined ${team} as ${role}: held in PoliNetwork Auth`, at.now)
      } else if (role && active && active.role !== role) {
        active.role = role
        log(p, "system", `Became ${role} of ${team}: held in PoliNetwork Auth`, at.now)
      } else if (!role && active && p.synced?.teams?.includes(team)) {
        Object.assign(active, { endedOn: at.date, endReason: "Role taken back in PoliNetwork Auth" })
        log(p, "system", `Ended ${team}: taken back in PoliNetwork Auth`, at.now)
      }
    }
    markSynced(p, bound, wanted)
  }
}

/**
 * Brings every member of the Microsoft 365 Soci group into the register: matched by Microsoft 365 account or address,
 * or by the PoliNetwork address of a linked account, otherwise as a new record. The member number is the account's
 * `employeeId`. Nothing is ended when someone leaves the group: the register's status stays with whoever keeps it.
 */
export function syncMembers(s: PeopleState, members: AzureMember[], at: Clock) {
  const persons = () => Object.values(s.persons)
  for (const m of members) {
    const mail = lower(m.mail)
    if (!mail) continue
    const match =
      persons().find((p) => p.azureId === m.id) ??
      persons().find((p) => lower(p.member?.m365Email) === mail) ??
      persons().find((p) => p.account.status === "linked" && lower(p.account.email) === mail)
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
    if (p.member) {
      p.member.m365Email ||= m.mail
      continue
    }
    const digits = m.employeeId?.trim() ?? ""
    const number = /^\d{1,4}$/.test(digits) ? digits.padStart(4, "0") : null
    if (!number || persons().some((other) => other.member?.number === number)) {
      const message = `In the Microsoft 365 Soci group without a usable member number (${digits || "none"})`
      if (!p.discrepancies.some((d) => d.message === message))
        p.discrepancies.push({ kind: "needs-review", message, suggestedTelegram: null })
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
    log(p, "system", `Imported member ${number} from the Microsoft 365 Soci group`, at.now)
  }
}
