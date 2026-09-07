import { bigint, boolean, integer, primaryKey, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { groupLabels } from "../common/group-labels"
import { createTable } from "../create-table"

export const waGroups = createTable.wa("groups", {
  id: bigint("group_id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  title: varchar("title").notNull(),
  link: varchar("link", { length: 128 }).unique(),
  hide: boolean("hide").default(false).notNull(),

  ...timeColumns,
})

export const waGroupLabelRelations = createTable.wa(
  "group_label_relations",
  {
    groupId: bigint("group_id", { mode: "number" })
      .references(() => waGroups.id, { onDelete: "cascade" })
      .notNull(),
    labelId: integer("label_id")
      .references(() => groupLabels.id)
      .notNull(),

    ...timeColumns,
  },
  (t) => [primaryKey(t.groupId, t.labelId)]
)
