import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const associations = createTable.web("associations", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  name: text("name").notNull(),
  descriptionIt: text("description_it").notNull(),
  descriptionEn: text("description_en").notNull(),
  logoSvg: text("logo_svg"),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
