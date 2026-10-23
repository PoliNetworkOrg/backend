import { customType, index, jsonb, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core"
import type { PeopleState, StoredReceipt } from "@/people/types"
import { createTable } from "../create-table"
import { requests } from "../esign/esign"

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
})

/** Small association metadata; files are separate so reading a roster never loads document bytes. */
export const records = createTable.people(
  "records",
  {
    id: text().primaryKey(),
    kind: text().$type<keyof PeopleState>().notNull(),
    data: jsonb().$type<unknown>().notNull(),
  },
  (t) => [index("people_records_kind_idx").on(t.kind)]
)

/** Unique identity and register constraints are relational, independent of the JSON projection. */
export const identities = createTable.people("identities", {
  personId: text("person_id").primaryKey(),
  accountSub: text("account_sub").unique(),
  memberNumber: text("member_number").unique(),
  telegramId: text("telegram_id").unique(),
})

export const files = createTable.people("files", {
  id: text().primaryKey(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  content: bytea().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
})

/** Receipt numbers and active request associations survive retries, decline and voiding. */
export const receipts = createTable.people("receipts", {
  id: text().primaryKey(),
  number: text().notNull().unique(),
  requestId: uuid("request_id")
    .references(() => requests.id, { onDelete: "restrict" })
    .unique(),
  data: jsonb().$type<StoredReceipt>().notNull(),
})

export const receiptRequests = createTable.people(
  "receipt_requests",
  {
    requestId: uuid("request_id")
      .primaryKey()
      .references(() => requests.id, { onDelete: "restrict" }),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => receipts.id, { onDelete: "restrict" }),
    officerSub: text("officer_sub").notNull(),
    originalHash: text("original_hash").notNull(),
  },
  (t) => [uniqueIndex("people_receipt_request_identity_idx").on(t.receiptId, t.requestId)]
)

export const schema = {
  peopleRecords: records,
  peopleIdentities: identities,
  peopleFiles: files,
  peopleReceipts: receipts,
  peopleReceiptRequests: receiptRequests,
}
