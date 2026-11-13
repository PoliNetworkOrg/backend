import { bigint, index, integer, text, unique } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const webDocumentCategories = createTable.web(
  "document_categories",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    position: integer("position").notNull().default(0),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_document_categories", t)]
)

export const webDocuments = createTable.web(
  "documents",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => webDocumentCategories.id, { onDelete: "restrict" }),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description"),
    position: integer("position").notNull().default(0),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_documents", t), index("web_documents_category_id_idx").on(t.categoryId)]
)

/** Every uploaded PDF of a document; the website shows the latest by date, then by id. */
export const webDocumentVersions = createTable.web(
  "document_versions",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    documentId: integer("document_id")
      .notNull()
      .references(() => webDocuments.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    /** YYYY-MM-DD, like the freshman guides. */
    date: text("date").notNull(),
    file: text("file").notNull(),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [
    hasCreator("web_document_versions", t),
    unique("web_document_versions_document_id_version_unique").on(t.documentId, t.version),
  ]
)
