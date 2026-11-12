import { sql } from "drizzle-orm"
import { check, date, index, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core"
import type { ACCOUNT_STATES, END_REASONS } from "@/soci/contract"
import { createTable } from "../create-table"

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })

/** The Libro Soci: one row per admission, never deleted. A re-admission is a new row with a new number. */
export const members = createTable.soci(
  "members",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    number: integer().notNull().unique(),
    entraObjectId: text("entra_object_id").notNull().unique(),
    /** Snapshots of the account, kept after it is deleted. */
    mailbox: text().notNull(),
    displayName: text("display_name").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    alias: text(),
    codiceFiscale: text("codice_fiscale"),
    birthDate: date("birth_date", { mode: "string" }),
    birthPlace: text("birth_place"),
    /** One line, as the Libro Soci writes it. */
    residence: text(),
    /** International format, e.g. `+393331234567`. */
    phone: text(),
    admittedOn: date("admitted_on", { mode: "string" }).notNull(),
    endedOn: date("ended_on", { mode: "string" }),
    endReason: text("end_reason").$type<(typeof END_REASONS)[number]>(),
    endNote: text("end_note"),
    accountState: text("account_state").$type<(typeof ACCOUNT_STATES)[number]>().notNull().default("active"),
    accountDeletedOn: date("account_deleted_on", { mode: "string" }),
    createdBy: text("created_by").notNull(),
    createdAt: at("created_at").notNull(),
    updatedBy: text("updated_by").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    // At most one active record per person.
    uniqueIndex("soci_members_active_codice_fiscale_idx")
      .on(t.codiceFiscale)
      .where(sql`${t.endedOn} is null and ${t.codiceFiscale} is not null`),
    check(
      "soci_members_end_check",
      sql`(${t.endedOn} is null) = (${t.endReason} is null) and (${t.endedOn} is not null or ${t.endNote} is null)`
    ),
    check(
      "soci_members_end_reason_check",
      sql`${t.endReason} in ('lapsed', 'resigned', 'expelled', 'deceased', 'other')`
    ),
    check("soci_members_account_state_check", sql`${t.accountState} in ('active', 'pending_deletion', 'deleted')`),
    check(
      "soci_members_account_deleted_check",
      sql`(${t.accountState} = 'deleted') = (${t.accountDeletedOn} is not null)`
    ),
    check("soci_members_number_check", sql`${t.number} > 0`),
  ]
)

/** Every member number a record has ever held: a number is never given to another record. */
export const numbers = createTable.soci(
  "numbers",
  {
    number: integer().primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    assignedAt: at("assigned_at").notNull(),
  },
  (t) => [index("soci_numbers_member_idx").on(t.memberId)]
)

/** Append-only history of each record. */
export const activity = createTable.soci(
  "activity",
  {
    /** Also orders entries written in the same instant. */
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    actor: text().notNull(),
    text: text().notNull(),
    at: at("at").notNull(),
  },
  (t) => [index("soci_activity_member_idx").on(t.memberId, t.id)]
)

export const schema = {
  sociMembers: members,
  sociNumbers: numbers,
  sociActivity: activity,
}
