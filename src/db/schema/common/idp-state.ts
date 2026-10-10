import { text, timestamp } from "drizzle-orm/pg-core"
import { createTable } from "../create-table"

/**
 * The last good IdP signing keys and access snapshot, so a restart during an IdP outage resumes
 * from them (RFC v3 §5.4, §6.5). Written by auth-kit through `src/idp/persistence.ts`.
 */
export const idpState = createTable.common("idp_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true }).notNull(),
})
