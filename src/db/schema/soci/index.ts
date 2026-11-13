import { sql } from "drizzle-orm"
import { check, customType, date, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import type { ACCOUNT_STATES, END_REASONS, FEE_STATUSES, PAYMENT_METHODS } from "@/soci/contract"
import type { FeeMailData, MailKind, SociMail } from "@/soci/types"
import { createTable } from "../create-table"

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const day = (name: string) => date(name, { mode: "string" })
const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
})

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

/** Uploaded transfer receipts, kept as payment records and never expired. */
export const files = createTable.soci(
  "files",
  {
    id: uuid().primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    content: bytea().notNull(),
    uploadedBy: text("uploaded_by").notNull(),
    uploadedAt: at("uploaded_at").notNull(),
  },
  (t) => [
    index("soci_files_member_idx").on(t.memberId),
    check("soci_files_type_check", sql`${t.contentType} in ('application/pdf', 'image/png', 'image/jpeg')`),
  ]
)

/** One socio's fee for one fee year (`year` is its first calendar year: 2026 is 2026/27). Amounts in cents. */
export const fees = createTable.soci(
  "fees",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    year: integer().notNull(),
    status: text().$type<(typeof FEE_STATUSES)[number]>().notNull(),
    amountCents: integer("amount_cents").notNull(),
    /** The last upload. A rejection keeps it, so the Direttivo can see what was refused. */
    fileId: uuid("file_id").references(() => files.id),
    transferDate: day("transfer_date"),
    declaredCents: integer("declared_cents"),
    uploadedAt: at("uploaded_at"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: at("reviewed_at"),
    /** The last rejection's reason, kept after a new upload. */
    rejectionReason: text("rejection_reason"),
    paidOn: day("paid_on"),
    method: text().$type<(typeof PAYMENT_METHODS)[number]>(),
    note: text(),
    recordedBy: text("recorded_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("soci_fees_member_year_idx").on(t.memberId, t.year),
    index("soci_fees_year_idx").on(t.year, t.status),
    check("soci_fees_status_check", sql`${t.status} in ('due', 'uploaded', 'paid', 'exempt')`),
    check("soci_fees_method_check", sql`${t.method} in ('transfer', 'admission', 'other')`),
    check(
      "soci_fees_paid_check",
      sql`(${t.status} = 'paid') = (${t.paidOn} is not null and ${t.method} is not null and ${t.recordedBy} is not null)`
    ),
    check(
      "soci_fees_upload_check",
      sql`${t.status} <> 'uploaded' or (${t.fileId} is not null and ${t.transferDate} is not null and ${t.declaredCents} is not null and ${t.uploadedAt} is not null)`
    ),
  ]
)

/** The outbox of fee emails, drained every minute. The id is the idempotency key, e.g. `reminder:2026:dec-1:12`. */
export const mail = createTable.soci(
  "mail",
  {
    id: text().primaryKey(),
    memberId: integer("member_id")
      .notNull()
      .references(() => members.id),
    to: text().notNull(),
    kind: text().$type<MailKind>().notNull(),
    data: jsonb().$type<FeeMailData>().notNull(),
    status: text().$type<SociMail["status"]>().notNull(),
    createdAt: at("created_at").notNull(),
    attemptedAt: at("attempted_at"),
    error: text(),
  },
  (t) => [
    index("soci_mail_status_idx").on(t.status),
    check("soci_mail_status_check", sql`${t.status} in ('pending', 'sending', 'sent', 'failed')`),
  ]
)

export const schema = {
  sociMembers: members,
  sociNumbers: numbers,
  sociActivity: activity,
  sociFiles: files,
  sociFees: fees,
  sociMail: mail,
}
