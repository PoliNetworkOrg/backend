import { bigint, integer, text, varchar } from "drizzle-orm/pg-core"
import { hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const groupLabels = createTable.common(
  "group_labels",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    label: varchar("label", { length: 128 }).notNull().unique(),
    description: varchar("description"),
    color: varchar("color", { length: 7 }).notNull().default("#ffffff"),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    // IdP subjects of the authors (RFC v3 §9.4); see `authorSubColumns`.
    createdBySub: text("created_by_sub"),
    updatedBySub: text("modified_by_sub"),

    ...timeColumns,
  },
  (t) => [hasCreator("common_group_labels", t)]
)
