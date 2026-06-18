import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const faqCategories = createTable.web("faq_categories", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  titleIt: text("title_it").notNull(),
  titleEn: text("title_en").notNull(),
  icon: text("icon"),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})

export const faqs = createTable.web("faqs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  titleIt: text("title_it").notNull(),
  titleEn: text("title_en").notNull(),
  descriptionIt: text("description_it").notNull(),
  descriptionEn: text("description_en").notNull(),
  categoryId: integer("category_id")
    .references(() => faqCategories.id, { onDelete: "cascade" })
    .notNull(),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
