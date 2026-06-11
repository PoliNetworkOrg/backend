import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const projectsCategories = ["news", "deprecated", "general"] as const

export type ProjectCategory = (typeof projectsCategories)[number]

export const projects = createTable.web("projects", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  title: text("title").notNull(),
  descriptionIt: text("description_it").notNull(),
  descriptionEn: text("description_en").notNull(),
  logo: text("logo"),
  link: text("link"),
  category: text("category", { enum: projectsCategories }).notNull().default("general"),
  order: integer("order").notNull().default(0),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
