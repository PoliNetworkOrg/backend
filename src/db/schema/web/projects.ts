import { bigint, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

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
    createdBy: bigint("created_by_id", { mode: "number" }).references(() => permissions.userId),
    modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_projects", t)]
)

/** Ways to use or get a project, shown on its detail page: the web app, a platform download or the source code. */
export const projectResourceKinds = ["web", "windows", "macos", "linux", "android", "ios", "source"] as const

export type ProjectResourceKind = (typeof projectResourceKinds)[number]

export const projectResources = createTable.web(
  "project_resources",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer("project_id")
      .references(() => projects.id, { onDelete: "cascade" })
      .notNull(),
    kind: text("kind", { enum: projectResourceKinds }).notNull(),
    url: text("url").notNull(),
    order: integer("order").notNull().default(0),
    createdBy: bigint("created_by_id", { mode: "number" }).references(() => permissions.userId),
    modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_project_resources", t)]
)
