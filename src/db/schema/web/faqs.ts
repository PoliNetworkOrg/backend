import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const faqCategories = createTable.web("faq_categories", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  icon: text("icon"),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})

export const faqs = createTable.web("faqs", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  categoryId: integer("category_id")
    .references(() => faqCategories.id, { onDelete: "cascade" })
    .notNull(),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
