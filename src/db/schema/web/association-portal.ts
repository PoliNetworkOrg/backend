import { sql } from "drizzle-orm"
import { boolean, check, customType, integer, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core"
import type { Mail, Record } from "@/associations/service"
import { createTable } from "../create-table"

/**
 * jsonb that reaches PostgreSQL as an object. Drizzle's `jsonb()` with Bun SQL sends a JSON-encoded string, which is
 * stored as a jsonb *string*: reads still parse, but `state->'published'` and other JSON operators then match nothing.
 */
export const jsonObject = <T>() =>
  customType<{ data: T; driverData: T }>({ dataType: () => "jsonb", toDriver: (value) => value })()

// One locked aggregate per association: requests, membership and publication change atomically.
export const associationRegistry = createTable.web("association_registry", {
  id: uuid().primaryKey(),
  state: jsonObject<Record>().notNull(),
  creationKey: text("creation_key").notNull().unique(),
})
export const associationMail = createTable.web("association_mail", {
  id: uuid().primaryKey(),
  mail: jsonObject<Mail>().notNull(),
  attempts: integer().notNull().default(0),
  nextAttempt: timestamp("next_attempt", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
})

// Degree programmes and campuses an association can list. Operators manage it; programme slugs follow the group labels.
export const associationCatalogue = createTable.web(
  "association_catalogue",
  {
    kind: varchar({ length: 16 }).$type<"programme" | "campus">().notNull(),
    slug: varchar({ length: 160 }).notNull(),
    nameIt: varchar("name_it", { length: 200 }).notNull(),
    nameEn: varchar("name_en", { length: 200 }).notNull(),
    active: boolean().notNull().default(true),
    updatedBySub: text("updated_by_sub"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.kind, t.slug] }),
    check("web_association_catalogue_kind", sql`${t.kind} IN ('programme', 'campus')`),
  ]
)
