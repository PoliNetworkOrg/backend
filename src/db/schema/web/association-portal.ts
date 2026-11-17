import { integer, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core"
import type { Mail, Record } from "@/associations/service"
import { createTable } from "../create-table"

// One locked aggregate per association: requests, membership and publication change atomically.
export const associationRegistry = createTable.web("association_registry", {
  id: uuid().primaryKey(),
  state: jsonb().$type<Record>().notNull(),
  creationKey: text("creation_key").notNull().unique(),
})
export const associationMail = createTable.web("association_mail", {
  id: uuid().primaryKey(),
  mail: jsonb().$type<Mail>().notNull(),
  attempts: integer().notNull().default(0),
  nextAttempt: timestamp("next_attempt", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
})
