import { customType, integer, text, timestamp, uuid } from "drizzle-orm/pg-core"
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
