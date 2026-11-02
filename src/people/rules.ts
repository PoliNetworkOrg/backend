/**
 * Who may give or take back a People role, kept shaped like PoliNetwork Auth's own rules
 * (`src/auth/people-binding.ts` in PoliNetworkOrg/auth): one rule per binding kind, with self-grants
 * and bounded delegation checked around them.
 *
 * Auth checks every change again when it applies it. The backend applies these rules too because it is
 * the only gate for assignments on records that aren't linked yet: Auth first sees those when the record
 * is linked. A rule added on one side (for example "a Capo Admin may add or remove the admins under
 * them") must be added on the other in the same shape.
 */

/** What holding a role means in People. Mirrors Auth's `PeopleBinding`. */
export type PeopleBinding =
  | { kind: "admin" }
  | { kind: "capo" }
  | { kind: "team"; team: string; role: "member" | "lead" }

/** Mirrors Auth's `PEOPLE_BINDING_PATTERN` and its `role_people_binding_check` constraint. */
export const PEOPLE_BINDING_PATTERN = /^(admin|capo|team:[a-z0-9-]{1,32}:(member|lead))$/

export function parsePeopleBinding(value: string | null | undefined): PeopleBinding | null {
  if (!value || !PEOPLE_BINDING_PATTERN.test(value)) return null
  if (value === "admin" || value === "capo") return { kind: value }
  const [, team, role] = value.split(":")
  return { kind: "team", team, role: role as "member" | "lead" }
}

export function bindingKey(binding: PeopleBinding) {
  return binding.kind === "team" ? `team:${binding.team}:${binding.role}` : binding.kind
}

export const ADMIN_ACCESS_PERMISSION = "admin:access"
export const PEOPLE_WRITE_PERMISSION = "people:write"
export const PEOPLE_APPOINT_PERMISSION = "people:appoint"
/** Holds every permission, so bounded delegation never limits them. */
export const MASTER_ADMIN_ROLE = "master-admin"

/** A role bound to People, as `GET /api/internal/people-roles` describes it. */
export type BoundRole = {
  key: string
  name: string
  binding: string
  /** Every permission the role grants, including through parent roles, when Auth says. */
  permissions?: string[]
  /** Its own binding and those of the roles it inherits, when Auth says. */
  bindings?: string[]
}

export type PeopleRoleChange = {
  actor: { sub: string; can: (permission: string) => boolean; holdsRole: (role: string) => boolean }
  /** The bindings of the roles the actor holds in Auth, including through a parent role. */
  held: PeopleBinding[]
  /** The account of the record being changed; null while it isn't linked. */
  targetSub: string | null
  role: BoundRole
  action: "assign" | "unassign"
  /**
   * What to do when Auth didn't say which permissions the role grants or which bindings it inherits. `defer`
   * for a linked record, where Auth checks when it applies the change; `refuse` for giving a role on one
   * that isn't linked, where nobody else will before the link. Ending such an assignment never reaches Auth.
   */
  unknownPermissions: "defer" | "refuse"
}

type PeopleRuleContext<B extends PeopleBinding = PeopleBinding> = PeopleRoleChange & {
  binding: B
  /** Whether the actor holds `admin:access` and `permission`. */
  general: (permission: string) => boolean
}
type PeopleRule<B extends PeopleBinding> = (context: PeopleRuleContext<B>) => string | null

const NEEDS_WRITE = "Changing this role needs people:write and admin:access."
const NEEDS_WRITE_OR_LEAD = "Changing this role needs people:write and admin:access, or leading the team."
const NEEDS_APPOINT = "Appointing or ending a Lead needs people:appoint and admin:access."
const NEEDS_APPOINT_CAPO = "Appointing or ending a Capo Admin needs people:appoint and admin:access."

/** One rule per binding kind, as in Auth: why the actor may not, or null when they may. */
export const PEOPLE_RULES: {
  [K in PeopleBinding["kind"]]: PeopleRule<Extract<PeopleBinding, { kind: K }>>
} = {
  admin: ({ general }) => (general(PEOPLE_WRITE_PERMISSION) ? null : NEEDS_WRITE),
  capo: ({ general }) => (general(PEOPLE_APPOINT_PERMISSION) ? null : NEEDS_APPOINT_CAPO),
  team: ({ binding, general, held }) => {
    if (binding.role === "lead") return general(PEOPLE_APPOINT_PERMISSION) ? null : NEEDS_APPOINT
    // A team's Lead may also add and remove that team's members.
    const leads = held.some((entry) => entry.kind === "team" && entry.team === binding.team && entry.role === "lead")
    return general(PEOPLE_WRITE_PERMISSION) || leads ? null : NEEDS_WRITE_OR_LEAD
  },
}

function ruleProblem(context: PeopleRuleContext): string | null {
  const rule = PEOPLE_RULES[context.binding.kind] as PeopleRule<PeopleBinding>
  return rule(context)
}

/**
 * Whether the actor may give or take back `role`; a reason when not. The same checks, in the same
 * order, as Auth's `peopleRoleChangeProblem`:
 * - nobody gives themselves a role; giving one up is always allowed;
 * - the rule of the role's binding kind, and of every binding it inherits;
 * - bounded delegation: unless Master Admin, the actor must already hold every permission the role grants.
 */
export function peopleRoleChangeProblem(change: PeopleRoleChange): string | null {
  const { actor, targetSub, role, action } = change
  const own = parsePeopleBinding(role.binding)
  if (!own) return "This role is not managed from People."
  if (targetSub === actor.sub) return action === "unassign" ? null : "Nobody can give themselves a role."

  const general = (key: string) => actor.can(ADMIN_ACCESS_PERMISSION) && actor.can(key)
  const unknown = change.unknownPermissions === "refuse" && action === "assign" && (!role.permissions || !role.bindings)
  // The role's own rule first, so a refusal names what the role itself needs.
  const inherited = (role.bindings ?? []).flatMap((value) => {
    const binding = parsePeopleBinding(value)
    return binding && bindingKey(binding) !== bindingKey(own) ? [binding] : []
  })
  for (const binding of [own, ...inherited]) {
    const refused = ruleProblem({ ...change, binding, general })
    if (refused) return refused
  }

  if (actor.holdsRole(MASTER_ADMIN_ROLE)) return null
  if (unknown)
    return "PoliNetwork Auth didn't say which permissions this role grants, so it can't be given before the record is linked."
  const missing = (role.permissions ?? []).filter((key) => !actor.can(key))
  return missing.length ? `This role grants permissions you do not hold (${missing.join(", ")}).` : null
}
