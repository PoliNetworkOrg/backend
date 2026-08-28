import { bigint, primaryKey, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { groups } from "./groups"
import { permissions } from "./permissions"

export const groupLabels = createTable.tg(
  "group_labels",
  {
    label: varchar("label", { length: 128 }).primaryKey(),
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

export const groupLabelRelations = createTable.tg(
  "group_label_relations",
  {
    groupId: bigint("group_id", { mode: "number" })
      .references(() => groups.telegramId)
      .notNull(),
    label: varchar("label", { length: 128 })
      .references(() => groupLabels.label)
      .notNull(),

    ...timeColumns,
  },
  (t) => [primaryKey(t.groupId, t.label)]
)
