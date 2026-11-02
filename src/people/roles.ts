import * as C from "./contract"
import { type BoundRole, type PeopleBinding, parsePeopleBinding } from "./rules"

/**
 * Roles in PoliNetwork Auth bound to People: `admin`, `capo`, `team:<id>:member` or `team:<id>:lead`.
 * For a linked record Auth is the source of truth for who holds them: People reads them with `directory`
 * and changes them with `change`, which Auth checks again against the acting dashboard user's access.
 */
export type RoleDirectory = {
  roles: BoundRole[]
  users: DirectoryUser[]
}
export type DirectoryUser = {
  sub: string
  name: string
  /** Their PoliNetwork address when they linked it, otherwise their sign-in address. */
  email: string | null
  telegramId: string | null
  telegramUsername: string | null
  /** Bound roles held, including through a parent role. */
  roles: string[]
  /** Those given directly, the only ones a change can take back. */
  assigned: string[]
  /** When each held role was first given (`YYYY-MM-DD`), when Auth says. */
  since?: Record<string, string>
}
export type RoleCommandChange =
  | { kind: "admin"; active: boolean }
  | { kind: "capo"; active: boolean }
  | { kind: "team"; team: C.TeamId; role: C.Assignment["teamRole"] }
/** `POST /api/internal/people-roles`: idempotent by `id`, applied all-or-nothing. */
export type RoleCommand = {
  id: string
  /** The dashboard user Auth checks the change against. */
  actor: string
  sub: string
  reason: string
  changes: RoleCommandChange[]
}
export type RoleResult = { roles: BoundRole[]; held: string[]; assigned: string[] }
export type PeopleRoles = {
  directory(): Promise<RoleDirectory>
  change(command: RoleCommand): Promise<RoleResult>
}

/** PoliNetwork Auth refused or failed a role change; `status` is its HTTP status. */
export class RoleChangeError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
  /**
   * No usable answer: the command may or may not have been applied, so it is sent again with the same ID.
   * Auth refusing the backend itself (a token it doesn't accept, or a client that isn't the backend's) is a
   * configuration problem, not a refusal of the change, so it counts too.
   */
  get unanswered() {
    return (
      this.status >= 500 ||
      this.status === 408 ||
      this.status === 429 ||
      this.status === 401 ||
      (this.status === 403 && this.message === "Forbidden")
    )
  }
}

type TeamRole = NonNullable<C.Assignment["teamRole"]>
/** One thing a person can hold: being an admin, a Capo Admin, or a role in one team. */
export type Concept = "admin" | "capo" | `team:${C.TeamId}`
/** What a person holds per concept. */
export type RoleView = { admin: boolean; capo: boolean; teams: Partial<Record<C.TeamId, TeamRole>> }

const isTeam = (value: string): value is C.TeamId => (C.TEAM_IDS as readonly string[]).includes(value)

export const conceptOf = (a: { kind: C.Assignment["kind"]; team: C.TeamId | null }): Concept =>
  a.kind === "team" ? `team:${a.team as C.TeamId}` : a.kind

/** The bound roles for one binding, e.g. `team:it:lead`. More than one makes the concept ambiguous. */
export function rolesFor(roles: readonly BoundRole[], binding: string) {
  return roles.filter((role) => role.binding === binding)
}

/** The bindings of the roles in `held`, ignoring teams People doesn't know. */
export function bindingsOf(roles: readonly BoundRole[], held: readonly string[]): PeopleBinding[] {
  return roles.flatMap((role) => {
    if (!held.includes(role.key)) return []
    const binding = parsePeopleBinding(role.binding)
    return binding && (binding.kind !== "team" || isTeam(binding.team)) ? [binding] : []
  })
}

/** What these roles mean in People; a Lead role wins over a member one. */
export function viewOf(roles: readonly BoundRole[], held: readonly string[]): RoleView {
  const view: RoleView = { admin: false, capo: false, teams: {} }
  for (const binding of bindingsOf(roles, held)) {
    if (binding.kind === "team") {
      const team = binding.team as C.TeamId
      if (view.teams[team] !== "lead") view.teams[team] = binding.role
    } else view[binding.kind] = true
  }
  return view
}

/** Whether Auth binds a role to the concept, so People may assign it. */
export function isBound(roles: readonly BoundRole[], concept: Concept) {
  if (concept === "admin" || concept === "capo") return rolesFor(roles, concept).length > 0
  return C.TEAM_ROLES.some((role) => rolesFor(roles, `${concept}:${role}`).length > 0)
}

/** When Auth first gave one of these roles, or `fallback` when it doesn't say. */
export function sinceOf(keys: readonly string[], since: Record<string, string> | undefined, fallback: string) {
  return (
    keys
      .map((key) => since?.[key])
      .filter((day): day is string => !!day)
      .sort()[0] ?? fallback
  )
}
