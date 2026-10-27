import { sql } from "drizzle-orm"
import { bigint, check, integer, text } from "drizzle-orm/pg-core"
import { authorSubColumns, hasCreator, timeColumns } from "@/db/columns"
import { freshmanIcons, freshmanSlots } from "@/routers/web/freshman/constants"
import { createTable } from "../create-table"
import { faqs } from "./faqs"

export const freshmanCards = createTable.web(
  "freshman_cards",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    icon: text("icon", { enum: freshmanIcons }).notNull(),
    href: text("href").notNull(),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [
    hasCreator("web_freshman_cards", t),
    check(
      "web_freshman_cards_slot_check",
      sql`${t.id} in (${sql.join(
        freshmanSlots.map((slot) => sql.raw(`'${slot.id}'`)),
        sql`, `
      )})`
    ),
    check(
      "web_freshman_cards_icon_check",
      sql`${t.icon} in (${sql.join(
        freshmanIcons.map((icon) => sql.raw(`'${icon}'`)),
        sql`, `
      )})`
    ),
  ]
)

export const freshmanFaqs = createTable.web(
  "freshman_faqs",
  {
    position: integer("position").primaryKey(),
    faqId: integer("faq_id")
      .notNull()
      .unique()
      .references(() => faqs.id, { onDelete: "restrict" }),
    legacyCreatedByTgId: bigint("legacy_created_by_tg_id", { mode: "number" }),
    legacyModifiedByTgId: bigint("legacy_modified_by_tg_id", { mode: "number" }),
    ...authorSubColumns,
    ...timeColumns,
  },
  (t) => [
    hasCreator("web_freshman_faqs", t),
    check("web_freshman_faqs_position_check", sql`${t.position} between 0 and 4`),
  ]
)
