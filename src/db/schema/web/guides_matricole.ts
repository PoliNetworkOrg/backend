import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const guidesMatricole = createTable.web("guides_matricole", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  version: text("version").notNull().unique(),
  date: text("date").notNull(),
  file: text("file").notNull(),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
