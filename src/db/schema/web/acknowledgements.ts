import { sql } from "drizzle-orm"
import { bigint, check, index, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

/**
 * The lists of the website's acknowledgements page (`/ringraziamenti`): `website` holds the people who made the
 * website, in role groups; `projects` the people behind PoliNetwork's projects, in one flat list.
 */
export const acknowledgementSections = ["website", "projects"] as const
export type AcknowledgementSection = (typeof acknowledgementSections)[number]

/** The icons a role group can show; the website and the dashboard map each one to an icon of their own. */
export const acknowledgementIcons = ["settings", "palette", "code", "smile", "users", "megaphone"] as const
export type AcknowledgementIcon = (typeof acknowledgementIcons)[number]

/** A role group of the `website` section (Project manager, Designer…), shown in `position` order. */
export const acknowledgementGroups = createTable.web(
  "acknowledgement_groups",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    title: text("title").notNull(),
    icon: text("icon", { enum: acknowledgementIcons }).notNull(),
    position: integer("position").notNull().default(0),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [hasCreator("web_acknowledgement_groups", t)]
)

/**
 * A person credited on the page: in a role group of the `website` section, or in the `projects` list (no group).
 * `detail` is the small label under the name: their role in the group, or the project they worked on.
 */
export const acknowledgements = createTable.web(
  "acknowledgements",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    section: text("section", { enum: acknowledgementSections }).notNull(),
    groupId: integer("group_id").references(() => acknowledgementGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    detail: text("detail"),
    position: integer("position").notNull().default(0),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [
    hasCreator("web_acknowledgements", t),
    // Only the website section has role groups, and each of its people belongs to one.
    check("web_acknowledgements_group_check", sql`(${t.section} = 'website') = (${t.groupId} IS NOT NULL)`),
    index("web_acknowledgements_group_id_idx").on(t.groupId),
  ]
)
