import { bigint, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const guidesMatricole = createTable.web(
  "guides_matricole",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    version: text("version").notNull().unique(),
    date: text("date").notNull(),
    file: text("file").notNull(),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_guides_matricole", t)]
)
