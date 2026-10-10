import { bigint, integer, text, varchar } from "drizzle-orm/pg-core"
import { hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const groupLabels = createTable.common(
  "group_labels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    label: varchar("label", { length: 128 }).notNull().unique(),
    description: varchar("description"),
    color: varchar("color", { length: 7 }).notNull().default("#ffffff"),
    createdBy: bigint("granted_by_id", { mode: "number" }).references(() => permissions.userId),
    updatedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
    // IdP subjects of token callers (RFC v3 §9.4); see `authorSubColumns`.
    createdBySub: text("created_by_sub"),
    updatedBySub: text("modified_by_sub"),

    ...timeColumns,
  },
  (t) => [t.label, t.createdBy, t.updatedBy, hasCreator("common_group_labels", t)]
)
