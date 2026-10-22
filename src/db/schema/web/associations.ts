import { bigint, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const associations = createTable.web(
  "associations",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    name: text("name").notNull(),
    descriptionIt: text("description_it").notNull(),
    descriptionEn: text("description_en").notNull(),
    logo: text("logo"),
    email: text("email"),
    website: text("website"),
    facebook: text("facebook"),
    instagram: text("instagram"),
    tiktok: text("tiktok"),
    x: text("x"),
    youtube: text("youtube"),
    telegram: text("telegram"),
    linkedin: text("linkedin"),
    spotify: text("spotify"),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_associations", t)]
)
