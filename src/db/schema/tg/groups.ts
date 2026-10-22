import { bigint, boolean, integer, primaryKey, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { groupLabels } from "../common/group-labels"
import { createTable } from "../create-table"

export const groups = createTable.tg("groups", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  title: varchar("title").notNull(),
  tag: varchar("tag"),
  link: varchar("link", { length: 128 }).unique(),
  hide: boolean("hide").notNull().default(false),

  ...timeColumns,
})

export const tgGroupLabelRelations = createTable.tg(
  "group_label_relations",
  {
    groupId: bigint("group_id", { mode: "number" })
      .references(() => groups.telegramId, { onDelete: "cascade" })
      .notNull(),
    labelId: integer("label_id")
      .references(() => groupLabels.id)
      .notNull(),

    ...timeColumns,
  },
  (t) => [primaryKey(t.groupId, t.labelId)]
)
