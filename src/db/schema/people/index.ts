import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import type { TeamFields } from "@/people/contract"
import type { RoleCommand } from "@/people/roles"
import { createTable } from "../create-table"

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

/** One record per person. Linked to a login account through `account_sub`, never through the contact email. */
export const persons = createTable.people("persons", {
  id: text().primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  /** Only for sending invites. */
  contactEmail: text("contact_email"),
  phone: text(),
  /** Informational only. */
  telegramUsername: text("telegram_username"),
  notes: text(),
  accountSub: text("account_sub").unique(),
  linkedAt: at("linked_at"),
  linkedBy: text("linked_by"),
  linkMethod: text("link_method").$type<"invite" | "manual" | "auth">(),
  createdBy: text("created_by").notNull(),
  createdAt: at("created_at").notNull(),
  updatedBy: text("updated_by").notNull(),
  updatedAt: at("updated_at").notNull(),
})

/** Role commands sent, or to be sent, to PoliNetwork Auth. Auth applies each `id` at most once. */
export const roleCommands = createTable.people(
  "role_commands",
  {
    id: uuid().primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id),
    request: jsonb().$type<RoleCommand>().notNull(),
    purpose: text().$type<"roles" | "unlink">().notNull().default("roles"),
    status: text().$type<"queued" | "applied" | "refused">().notNull(),
    attempts: integer().notNull().default(0),
    error: text(),
    createdAt: at("created_at").notNull(),
    answeredAt: at("answered_at"),
  },
  (t) => [
    index("people_role_commands_queued_idx").on(t.createdAt).where(sql`${t.status} = 'queued'`),
    check("people_role_commands_status_check", sql`${t.status} in ('queued', 'applied', 'refused')`),
    check("people_role_commands_purpose_check", sql`${t.purpose} in ('roles', 'unlink')`),
  ]
)

/** Group Admin, Capo Admin, or a role in a team. At most one current assignment per concept and person. */
export const assignments = createTable.people(
  "assignments",
  {
    id: uuid().primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id),
    kind: text().$type<"admin" | "capo" | "team">().notNull(),
    team: text(),
    teamRole: text("team_role").$type<"member" | "lead">(),
    /** For `capo`, e.g. "Ingegneria Informatica". */
    capoScope: text("capo_scope"),
    /** For `admin`: the record of their Capo Admin. */
    capoOfReferenceId: text("capo_of_reference_id").references((): AnyPgColumn => persons.id),
    fields: jsonb().$type<TeamFields>().notNull().default({}),
    since: date({ mode: "string" }).notNull(),
    endedOn: date("ended_on", { mode: "string" }),
    endReason: text("end_reason"),
    assignedBy: text("assigned_by").notNull(),
    change: text().$type<"start" | "end">().notNull(),
    status: text().$type<"pending" | "sent" | "applied" | "refused">().notNull(),
    refusal: text(),
    commandId: uuid("command_id").references(() => roleCommands.id),
  },
  (t) => [
    index("people_assignments_person_idx").on(t.personId),
    uniqueIndex("people_assignments_current_idx")
      .on(t.personId, t.kind, sql`coalesce(${t.team}, '')`)
      .where(sql`${t.endedOn} is null`),
    check("people_assignments_kind_check", sql`${t.kind} in ('admin', 'capo', 'team')`),
    check(
      "people_assignments_team_check",
      sql`(${t.kind} = 'team') = (${t.team} is not null and ${t.teamRole} in ('member', 'lead'))`
    ),
    check("people_assignments_capo_ref_check", sql`${t.kind} = 'admin' or ${t.capoOfReferenceId} is null`),
    check("people_assignments_change_check", sql`${t.change} in ('start', 'end')`),
    check("people_assignments_status_check", sql`${t.status} in ('pending', 'sent', 'applied', 'refused')`),
    check("people_assignments_sent_check", sql`(${t.status} = 'sent') = (${t.commandId} is not null)`),
  ]
)

/** Email invites to link a record to an account. Only the token's hash is stored. */
export const invites = createTable.people(
  "invites",
  {
    id: uuid().primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id),
    tokenHash: text("token_hash").notNull().unique(),
    email: text().notNull(),
    sentBy: text("sent_by").notNull(),
    sentAt: at("sent_at").notNull(),
    expiresAt: at("expires_at").notNull(),
    revokedAt: at("revoked_at"),
    acceptedAt: at("accepted_at"),
    acceptedBy: text("accepted_by"),
  },
  (t) => [index("people_invites_person_idx").on(t.personId)]
)

/** The durable mail outbox. */
export const mail = createTable.people("mail", {
  id: text().primaryKey(),
  personId: text("person_id")
    .notNull()
    .references(() => persons.id),
  to: text().notNull(),
  subject: text().notNull(),
  text: text().notNull(),
  status: text().$type<"pending" | "sending" | "sent" | "failed">().notNull(),
  attemptedAt: at("attempted_at"),
  error: text(),
})

/** Append-only history of changes to a record. */
export const activity = createTable.people(
  "activity",
  {
    /** Also orders entries written in the same instant. */
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    personId: text("person_id")
      .notNull()
      .references(() => persons.id),
    actor: text().notNull(),
    text: text().notNull(),
    at: at("at").notNull(),
  },
  (t) => [index("people_activity_person_idx").on(t.personId, t.id)]
)

export const counters = createTable.people("counters", {
  key: text().primaryKey(),
  /** Wide enough for a timestamp in milliseconds, like `directoryReadAt`. */
  value: bigint({ mode: "number" }).notNull(),
})

export const schema = {
  peoplePersons: persons,
  peopleAssignments: assignments,
  peopleRoleCommands: roleCommands,
  peopleInvites: invites,
  peopleMail: mail,
  peopleActivity: activity,
  peopleCounters: counters,
}
