import { sql } from "drizzle-orm"
import { bigint, index, jsonb, text, timestamp, varchar } from "drizzle-orm/pg-core"
import { createTable } from "../create-table"

/** Who made a change: the kinds of RFC v3 actors, and `legacy` for anonymous legacy callers. */
export const AUDIT_ACTOR_KIND = {
  USER: "user",
  TELEGRAM: "telegram",
  SERVICE: "service",
  LEGACY: "legacy",
} as const
export type TAuditActorKind = (typeof AUDIT_ACTOR_KIND)[keyof typeof AUDIT_ACTOR_KIND]

export const AUDIT_OUTCOME = {
  SUCCESS: "success",
  /** The call ran but changed nothing: an error was thrown or returned. */
  FAILURE: "failure",
  /** The caller lacked the scope or permission. */
  DENIED: "denied",
} as const
export type TAuditOutcome = (typeof AUDIT_OUTCOME)[keyof typeof AUDIT_OUTCOME]

/** JSON as stored in the event: inputs and states are copied without secrets or file contents. */
export type AuditJson = null | boolean | number | string | AuditJson[] | { [key: string]: AuditJson }

/**
 * Every change made through the backend, whoever made it: one row per mutation, written by the tRPC audit middleware
 * (`src/audit`). Telegram moderation, recorded by the bot through `tg.auditLog`, is copied here too.
 */
export const auditEvents = createTable.common(
  "audit_events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** The procedure path, e.g. `web.faqs.editFaqs`, or `tg.moderation.<type>` for Telegram moderation. */
    action: text("action").notNull(),
    actorKind: varchar("actor_kind", { length: 16 }).$type<TAuditActorKind>().notNull(),
    actorSub: text("actor_sub"),
    actorTgId: bigint("actor_tg_id", { mode: "number" }),
    /** The OAuth client that made the call, e.g. `admin-dashboard`; null for legacy callers. */
    actorClient: text("actor_client"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    /** A readable name for the target when the event was written, e.g. a FAQ's title. */
    targetLabel: text("target_label"),
    reason: text("reason"),
    outcome: varchar("outcome", { length: 16 }).$type<TAuditOutcome>().notNull(),
    error: text("error"),
    input: jsonb("input").$type<AuditJson>(),
    before: jsonb("before").$type<AuditJson>(),
    after: jsonb("after").$type<AuditJson>(),
    createdAt: timestamp("created_at", { precision: 3, withTimezone: true }).default(sql`now()`).notNull(),
  },
  (t) => [
    index("common_audit_events_action_idx").on(t.action),
    index("common_audit_events_actor_sub_idx").on(t.actorSub),
    index("common_audit_events_actor_tg_id_idx").on(t.actorTgId),
    index("common_audit_events_target_idx").on(t.targetType, t.targetId),
  ]
)
