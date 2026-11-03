import { type SQL, sql } from "drizzle-orm"
import { check, type PgColumn, text, timestamp } from "drizzle-orm/pg-core"

export const timeColumns = {
  updatedAt: timestamp("updated_at", { precision: 0, withTimezone: true }).$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { precision: 0, withTimezone: true }).default(sql`now()`).notNull(),
}

/**
 * IdP subject of whoever created or last modified a row (RFC v3 §9.4). Rows written before the
 * IdP migration keep their author's Telegram ID in the `legacy_*_tg_id` columns instead.
 */
export const authorSubColumns = {
  createdBySub: text("created_by_sub"),
  modifiedBySub: text("modified_by_sub"),
}

/** Every row keeps a creator: an IdP subject, or a legacy Telegram ID for older rows. */
export function hasCreator(table: string, columns: { legacyCreatedByTgId: PgColumn; createdBySub: PgColumn }) {
  const condition: SQL = sql`${columns.legacyCreatedByTgId} IS NOT NULL OR ${columns.createdBySub} IS NOT NULL`
  return check(`${table}_creator_check`, condition)
}
