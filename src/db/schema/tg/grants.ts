import { sql } from "drizzle-orm"
import { bigint, check, index, integer, text, timestamp } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "./permissions"

/**
 * Grants made by legacy callers, identified by Telegram ID. Archived and dropped in Phase 6
 * (RFC v3 §9.3); until then a grant is active if it is active here or in `grantsV2`.
 */
export const grants = createTable.tg(
  "grants",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }).notNull(),
    grantedBy: bigint("granted_by_id", { mode: "number" })
      .references(() => permissions.userId)
      .notNull(),
    validSince: timestamp("valid_since", { precision: 0, withTimezone: true }).notNull(),
    validUntil: timestamp("valid_until", { precision: 0, withTimezone: true }).notNull(),
    interruptedBy: bigint("interrupted_by_id", { mode: "number" }).references(() => permissions.userId),
    /** Set when a token caller interrupts a legacy grant: it has no `tg_permissions` row to reference. */
    interruptedAt: timestamp("interrupted_at", { precision: 0, withTimezone: true }),
    reason: text("reason"),

    ...timeColumns,
  },
  (t) => [index("tg_grants_user_id_idx").on(t.userId)]
)

/**
 * Grants made by IdP-authenticated callers (RFC v3 §9.3). Active means
 * `valid_since ≤ now < valid_until` and not interrupted; who interrupted never matters.
 */
export const grantsV2 = createTable.tg(
  "grants_v2",
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
    index("tg_grants_v2_telegram_user_id_idx").on(t.telegramUserId),
    check("tg_grants_v2_validity_check", sql`${t.validSince} < ${t.validUntil}`),
  ]
)
