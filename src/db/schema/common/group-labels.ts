import { bigint, integer, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const groupLabels = createTable.common(
  "group_labels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    label: varchar("label", { length: 128 }).notNull().unique(),
    description: varchar("description"),
    color: varchar("color", { length: 7 }).notNull().default("#ffffff"),
    createdBy: bigint("granted_by_id", { mode: "number" })
      .references(() => permissions.userId)
      .notNull(),
    updatedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),

    ...timeColumns,
  },
  (t) => [t.label, t.createdBy, t.updatedBy]
)
