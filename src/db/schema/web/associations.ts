import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const associations = createTable.web("associations", {
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
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
