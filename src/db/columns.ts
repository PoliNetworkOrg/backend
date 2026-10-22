import { type SQL, sql } from "drizzle-orm"
import { check, type PgColumn, text, timestamp } from "drizzle-orm/pg-core"

export const timeColumns = {
  updatedAt: timestamp("updated_at", { precision: 0, withTimezone: true }).$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { precision: 0, withTimezone: true }).default(sql`now()`).notNull(),
}

/**
 * IdP subject of whoever created or last modified a row (RFC v3 §9.4). Token callers are
 * recorded here; legacy callers in the Telegram ID columns. Writes set one of each pair and clear
 * the other, but an older release (after a rollback) only writes the Telegram ID column.
 */
export const authorSubColumns = {
  createdBySub: text("created_by_sub"),
  modifiedBySub: text("modified_by_sub"),
}

/** Every row keeps a creator: a legacy Telegram ID or an IdP subject. */
export function hasCreator(table: string, columns: { createdBy: PgColumn; createdBySub: PgColumn }) {
  const condition: SQL = sql`${columns.createdBy} IS NOT NULL OR ${columns.createdBySub} IS NOT NULL`
  return check(`${table}_creator_check`, condition)
}
