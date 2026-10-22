import { sql } from "drizzle-orm"
import { bigint, check, index, integer, text, timestamp } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

/**
 * Temporary trust for a Telegram user, granted through the IdP (RFC v3 §9.3). Active means
 * `valid_since ≤ now < valid_until` and not interrupted; who interrupted never matters.
 */
export const grants = createTable.tg(
  "grants",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    telegramUserId: bigint("telegram_user_id", { mode: "number" }).notNull(),
    validSince: timestamp("valid_since", { precision: 0, withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { precision: 0, withTimezone: true }).notNull(),
    reason: text("reason"),
    grantedBySub: text("granted_by_sub").notNull(),
    grantedViaClient: text("granted_via_client").notNull(),
    interruptedAt: timestamp("interrupted_at", { precision: 0, withTimezone: true }),
    interruptedBySub: text("interrupted_by_sub"),
    interruptedByTgId: bigint("interrupted_by_tg_id", { mode: "number" }),

    ...timeColumns,
  },
  (t) => [
    index("tg_grants_telegram_user_id_idx").on(t.telegramUserId),
    check("tg_grants_validity_check", sql`${t.validSince} < ${t.validUntil}`),
  ]
)
