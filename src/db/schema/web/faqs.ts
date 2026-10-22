import { bigint, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const faqCategories = createTable.web(
  "faq_categories",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    titleIt: text("title_it").notNull(),
    titleEn: text("title_en").notNull(),
    icon: text("icon"),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_faq_categories", t)]
)

export const faqs = createTable.web(
  "faqs",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    titleIt: text("title_it").notNull(),
    titleEn: text("title_en").notNull(),
    descriptionIt: text("description_it").notNull(),
    descriptionEn: text("description_en").notNull(),
    categoryId: integer("category_id")
      .references(() => faqCategories.id, { onDelete: "cascade" })
      .notNull(),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_faqs", t)]
)
