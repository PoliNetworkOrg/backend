import type * as C from "./contract"
import type { RoleCommand } from "./roles"

/** The signed-in dashboard user, as the access snapshot sees them. */
export type Viewer = {
  sub: string
  telegramId: string | null
  can: (permission: string) => boolean
  /** Whether they hold the role in Auth, directly or through a parent role. */
  holdsRole: (role: string) => boolean
}

export type Person = {
  id: string
  firstName: string
  lastName: string
  /** Only for sending invites. Never used to match accounts. */
  contactEmail: string | null
  phone: string | null
  /** Informational only. */
  telegramUsername: string | null
  notes: string | null
  /** The login account the record is linked to. */
  accountSub: string | null
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
}

export type Assignment = {
  id: string
  personId: string
  kind: (typeof C.ASSIGNMENT_KINDS)[number]
  team: C.TeamId | null
  teamRole: (typeof C.TEAM_ROLES)[number] | null
  capoScope: string | null
  /** For `admin`: the person record of their Capo Admin. */
  capoOfReferenceId: string | null
  fields: C.TeamFields
  since: string
  endedOn: string | null
  endReason: string | null
  /** The sub of whoever made it; `auth` when it was made by hand in PoliNetwork Auth. */
  assignedBy: string
  change: "start" | "end"
  status: (typeof C.ASSIGNMENT_STATUSES)[number]
  refusal: string | null
  /** The role command that carries `change` to Auth, while `status` is `sent`. */
  commandId: string | null
}

/** A role command waiting in, or answered from, the outbox to PoliNetwork Auth. */
export type StoredCommand = {
  id: string
  personId: string
  request: RoleCommand
  status: "queued" | "applied" | "refused"
  attempts: number
  error: string | null
  createdAt: string
  answeredAt: string | null
}

export type Invite = {
  id: string
  personId: string
  tokenHash: string
  email: string
  sentBy: string
  sentAt: string
  expiresAt: string
  revokedAt: string | null
  acceptedAt: string | null
  acceptedBy: string | null
}

export type Mail = {
  id: string
  personId: string
  to: string
  subject: string
  text: string
  status: "pending" | "sending" | "sent" | "failed"
  attemptedAt: string | null
  error: string | null
}

export type Activity = { personId: string; actor: string; text: string; at: string }

/** Everything but the activity history, which is append-only and read per person. */
export type PeopleState = {
  persons: Record<string, Person>
  assignments: Record<string, Assignment>
  commands: Record<string, StoredCommand>
  invites: Record<string, Invite>
  mail: Record<string, Mail>
  /** `roleRevision` advances whenever Auth confirms or refuses a role change. */
  counters: Record<string, number>
}
export const emptyState = (): PeopleState => ({
  persons: {},
  assignments: {},
  commands: {},
  invites: {},
  mail: {},
  counters: {},
})

export type UnitOfWork = {
  state: PeopleState
  /** Activity entries written in this transaction; the store only ever appends them. */
  activity: Activity[]
  /**
   * Records folded into another in this transaction (see `absorb`): their history moves to `into`, and the
   * store deletes them, the only records it ever deletes.
   */
  merges: { from: string; into: string }[]
}
export interface PeopleStore {
  /** One serialized write transaction over the register. */
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>
  /** A person's activity history, newest first. */
  activity(personId: string): Promise<Activity[]>
}

/** A login account in the IdP directory. */
export type Account = {
  sub: string
  name: string
  email: string | null
}
