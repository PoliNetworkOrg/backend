import { bigint, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const projectsCategories = ["news", "deprecated", "general"] as const

export type ProjectCategory = (typeof projectsCategories)[number]

export const projects = createTable.web(
  "projects",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    descriptionIt: text("description_it").notNull(),
    descriptionEn: text("description_en").notNull(),
    logo: text("logo"),
    link: text("link"),
    category: text("category", { enum: projectsCategories }).notNull().default("general"),
    order: integer("order").notNull().default(0),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_projects", t)]
)
