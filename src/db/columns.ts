import { sql } from "drizzle-orm"
import { timestamp } from "drizzle-orm/pg-core"

export const timeColumns = {
  updatedAt: timestamp("updated_at", { precision: 0, withTimezone: true }).$onUpdate(() => new Date()),
  createdAt: timestamp("created_at", { precision: 0, withTimezone: true }).default(sql`now()`).notNull(),
}
