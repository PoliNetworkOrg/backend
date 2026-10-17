import { sql } from "drizzle-orm"
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  serial,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
})

const tstz = (name: string) => timestamp(name, { precision: 3, withTimezone: true })

/** Where a signature goes: fractions of the displayed page, origin top-left (see esign/pdf/geometry). */
export type PlacementJson = { page: number; x: number; y: number; width: number; height: number }
/**
 * One of a signer's places: "signature" places each get their own cryptographic signature; "mark" places repeat the
 * visible mark of the signer's first signature, which covers them.
 */
export type PlaceJson = PlacementJson & { kind: "signature" | "mark" }
export type OutputJson = { driveId: string; folderId: string; folderPath: string; fileName: string }
export type EmailJson = { to: string[]; message: string | null }
export type DeliveryJson = {
  status: "pending" | "delivered" | "failed"
  driveItem: { id: string; name: string; webUrl: string | null } | null
  emailedTo: string[]
  error: string | null
  attemptedAt: string | null
}
export type SourceJson =
  | { kind: "upload" }
  | { kind: "drive"; driveId: string; itemId: string; name: string; webUrl: string | null }

/** Dashboard users who sign: display data from the IdP, and the CIE identity bound on their first signature. */
export const profiles = createTable.esign("profiles", {
  sub: text().primaryKey(),
  name: text().notNull(),
  email: text(),
  /** Codice fiscale from the first CIE used; later signatures must match. Reset by a manager. */
  fiscalCode: text("fiscal_code"),
  certificateSubject: text("certificate_subject"),
  ...timeColumns,
})

export const requests = createTable.esign(
  "requests",
  {
    id: uuid().primaryKey().defaultRandom(),
    title: text().notNull(),
    status: text({ enum: ["in_progress", "completed", "cancelled", "declined"] })
      .notNull()
      .default("in_progress"),
    /** Signers sign in `position` order; otherwise in any order, one at a time. */
    ordered: boolean().notNull().default(true),
    /** Where the signed PDF goes; null keeps it only in the dashboard. */
    output: jsonb().$type<OutputJson>(),
    email: jsonb().$type<EmailJson>(),
    delivery: jsonb().$type<DeliveryJson>(),
    createdBySub: text("created_by_sub").notNull(),
    completedAt: tstz("completed_at"),
    cancelledAt: tstz("cancelled_at"),
    ...timeColumns,
  },
  (t) => [index("esign_requests_status_idx").on(t.status), index("esign_requests_created_by_idx").on(t.createdBySub)]
)

/** Every revision of a request's PDF; version 0 is the original. Staged uploads have no request yet. */
export const documents = createTable.esign(
  "documents",
  {
    id: uuid().primaryKey().defaultRandom(),
    requestId: uuid("request_id").references(() => requests.id, { onDelete: "cascade" }),
    version: integer().notNull().default(0),
    fileName: text("file_name").notNull(),
    content: bytea().notNull(),
    sha256: text().notNull(),
    size: integer().notNull(),
    pages: integer().notNull(),
    source: jsonb().$type<SourceJson>().notNull(),
    createdBySub: text("created_by_sub").notNull(),
    createdAt: tstz("created_at").default(sql`now()`).notNull(),
  },
  (t) => [
    uniqueIndex("esign_documents_request_version_idx")
      .on(t.requestId, t.version)
      .where(sql`${t.requestId} IS NOT NULL`),
  ]
)

export const signers = createTable.esign(
  "signers",
  {
    id: uuid().primaryKey().defaultRandom(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    position: integer().notNull(),
    sub: text().notNull(),
    /** The signer's name when the request was made. */
    name: text().notNull(),
    role: text(),
    places: jsonb().$type<PlaceJson[]>().notNull(),
    /** Signature places already signed: a signature interrupted after some of them resumes from here. */
    signaturesDone: integer("signatures_done").notNull().default(0),
    status: text({ enum: ["pending", "signed", "declined"] })
      .notNull()
      .default("pending"),
    signedAt: tstz("signed_at"),
    /** The document version this signature produced. */
    version: integer(),
    fiscalCode: text("fiscal_code"),
    certificateSubject: text("certificate_subject"),
    certificateIssuer: text("certificate_issuer"),
    declineReason: text("decline_reason"),
    ...timeColumns,
  },
  (t) => [
    index("esign_signers_request_idx").on(t.requestId),
    index("esign_signers_sub_idx").on(t.sub),
    uniqueIndex("esign_signers_request_position_idx").on(t.requestId, t.position),
  ]
)

export type PreparedJson = {
  byteRange: [number, number, number, number]
  contentsOffset: number
  contentsHexLength: number
  signedAttrs: string
  toBeSigned: string
  certificate: string
  chain: string[]
  signingTime: string
  /** OCSP result at prepare time, for the audit trail. */
  revocation?: { status: "good" | "revoked" | "unknown"; detail: string | null; checkedAt: string } | null
}

/** One attempt at a signature, reached by the agent through a single-use ticket. */
export const jobs = createTable.esign(
  "jobs",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** SHA-256 of the ticket; the ticket itself is never stored. */
    ticketHash: text("ticket_hash").notNull().unique(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    signerId: uuid("signer_id")
      .notNull()
      .references(() => signers.id, { onDelete: "cascade" }),
    sub: text().notNull(),
    status: text({ enum: ["pending", "prepared", "completed", "failed", "cancelled", "expired"] })
      .notNull()
      .default("pending"),
    /** The document version the next signature applies to. */
    baseVersion: integer("base_version").notNull(),
    /** The signer's places when the job started. */
    places: jsonb().$type<PlaceJson[]>().notNull(),
    /** Index of the next signature place to sign, among the signature places. */
    step: integer().notNull().default(0),
    expiresAt: tstz("expires_at").notNull(),
    prepared: jsonb().$type<PreparedJson>(),
    preparedPdf: bytea("prepared_pdf"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    seenAt: tstz("seen_at"),
    completedAt: tstz("completed_at"),
    ...timeColumns,
  },
  (t) => [index("esign_jobs_request_idx").on(t.requestId)]
)

/** Audit trail of a request. */
export const events = createTable.esign(
  "events",
  {
    id: serial().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => requests.id, { onDelete: "cascade" }),
    at: tstz("at").default(sql`now()`).notNull(),
    actorSub: text("actor_sub"),
    type: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>(),
  },
  (t) => [index("esign_events_request_idx").on(t.requestId)]
)
