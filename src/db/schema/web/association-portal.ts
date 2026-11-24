import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core"
import type {
  CalendarEventContent,
  CreditConfig,
  EventStatus,
  PromotionContent,
  PromotionStatus,
} from "@/associations/contract"
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

const PROMOTION_STATUSES =
  "'draft', 'submitted', 'changes_requested', 'approved', 'scheduled', 'published', 'rejected', 'withdrawn'"

// Promotion requests have their own rows: many per association, queried across associations by operators.
export const associationPromotion = createTable.web(
  "association_promotion",
  {
    id: uuid().primaryKey(),
    associationId: uuid("association_id")
      .notNull()
      .references(() => associationRegistry.id),
    status: varchar({ length: 24 }).$type<PromotionStatus>().notNull(),
    revision: integer().notNull().default(0),
    content: jsonObject<PromotionContent>().notNull(),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull(),
    /** Addresses that hear about every transition (author, submitter). */
    notify: text().array().notNull(),
    desiredDate: date("desired_date"),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    scheduledChannel: varchar("scheduled_channel", { length: 32 }),
    scheduledDetail: text("scheduled_detail").notNull().default(""),
    publishedUrl: text("published_url"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("web_association_promotion_association_idx").on(t.associationId),
    index("web_association_promotion_queue_idx").on(t.status, t.desiredDate),
    check("web_association_promotion_status", sql.raw(`status IN (${PROMOTION_STATUSES})`)),
  ]
)
// Append-only (a trigger rejects UPDATE and DELETE): who moved a request, when, and why.
export const associationPromotionTransition = createTable.web(
  "association_promotion_transition",
  {
    id: uuid().primaryKey(),
    promotionId: uuid("promotion_id")
      .notNull()
      .references(() => associationPromotion.id),
    kind: varchar({ length: 16 }).$type<"transition" | "comment">().notNull(),
    fromStatus: varchar("from_status", { length: 24 }).$type<PromotionStatus>(),
    toStatus: varchar("to_status", { length: 24 }).$type<PromotionStatus>(),
    actorSub: text("actor_sub").notNull(),
    actorName: text("actor_name").notNull(),
    note: text().notNull().default(""),
    internal: boolean().notNull().default(false),
    at: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("web_association_promotion_transition_promotion_idx").on(t.promotionId, t.at)]
)
// Per-account command keys for operations outside the registry aggregate: a retried command returns its first result.
export const associationCommandKey = createTable.web("association_command_key", {
  key: text().primaryKey(),
  result: uuid().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
})

const EVENT_STATUSES = "'draft', 'submitted', 'changes_requested', 'approved', 'rejected', 'withdrawn'"

// Calendar events: public on the website once approved, linked to the association's profile.
export const associationEvent = createTable.web(
  "association_event",
  {
    id: uuid().primaryKey(),
    associationId: uuid("association_id")
      .notNull()
      .references(() => associationRegistry.id),
    status: varchar({ length: 24 }).$type<EventStatus>().notNull(),
    revision: integer().notNull().default(0),
    content: jsonObject<CalendarEventContent>().notNull(),
    createdBy: text("created_by").notNull(),
    createdByName: text("created_by_name").notNull(),
    notify: text().array().notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("web_association_event_association_idx").on(t.associationId),
    index("web_association_event_calendar_idx").on(t.status, t.startsAt),
    check("web_association_event_status", sql.raw(`status IN (${EVENT_STATUSES})`)),
  ]
)
// Append-only, like the promotion transitions.
export const associationEventTransition = createTable.web(
  "association_event_transition",
  {
    id: uuid().primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => associationEvent.id),
    kind: varchar({ length: 16 }).$type<"transition" | "comment">().notNull(),
    fromStatus: varchar("from_status", { length: 24 }).$type<EventStatus>(),
    toStatus: varchar("to_status", { length: 24 }).$type<EventStatus>(),
    actorSub: text("actor_sub").notNull(),
    actorName: text("actor_name").notNull(),
    note: text().notNull().default(""),
    internal: boolean().notNull().default(false),
    at: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index("web_association_event_transition_event_idx").on(t.eventId, t.at)]
)

// Credits: an append-only ledger per association (a trigger rejects UPDATE and DELETE); the balance is the sum.
// Unique indexes make a second debit for a request, a second reversal of a debit, or a second grant for a period
// impossible, whatever the application does.
export const associationCreditEntry = createTable.web(
  "association_credit_entry",
  {
    id: uuid().primaryKey(),
    associationId: uuid("association_id")
      .notNull()
      .references(() => associationRegistry.id),
    kind: varchar({ length: 16 }).$type<"credit" | "debit" | "reversal" | "adjustment">().notNull(),
    /** Hundredths of a credit: positive adds, negative spends. */
    amount: integer().notNull(),
    reason: text().notNull(),
    authorSub: text("author_sub").notNull(),
    authorName: text("author_name").notNull(),
    promotionId: uuid("promotion_id").references(() => associationPromotion.id),
    reversesId: uuid("reverses_id").references((): AnyPgColumn => associationCreditEntry.id),
    period: varchar({ length: 40 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("web_association_credit_entry_association_idx").on(t.associationId, t.createdAt),
    uniqueIndex("web_association_credit_entry_one_debit").on(t.promotionId).where(sql`kind = 'debit'`),
    uniqueIndex("web_association_credit_entry_one_reversal").on(t.reversesId),
    uniqueIndex("web_association_credit_entry_one_grant")
      .on(t.associationId, t.period)
      .where(sql`kind = 'credit' AND period IS NOT NULL`),
    check(
      "web_association_credit_entry_sign",
      sql`(kind = 'credit' AND amount > 0) OR (kind = 'debit' AND amount < 0) OR (kind = 'reversal' AND amount > 0) OR (kind = 'adjustment' AND amount <> 0)`
    ),
  ]
)
// The credit rules, one row, editable by operators (seeded from RRI art. 4.7, turned off).
export const associationCreditConfig = createTable.web(
  "association_credit_config",
  {
    id: integer().primaryKey(),
    config: jsonObject<CreditConfig>().notNull(),
    updatedBySub: text("updated_by_sub"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [check("web_association_credit_config_single", sql`${t.id} = 1`)]
)
