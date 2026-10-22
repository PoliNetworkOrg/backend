import { bigint, index, integer, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const AUDIT_TYPE = {
  BAN: "ban",
  UNBAN: "unban",
  KICK: "kick",
  MUTE: "mute",
  UNMUTE: "unmute",
  BAN_ALL: "ban_all",
  UNBAN_ALL: "unban_all",
} as const
export type TAuditType = (typeof AUDIT_TYPE)[keyof typeof AUDIT_TYPE]

export const ARRAY_AUDIT_TYPE = [
  AUDIT_TYPE.BAN,
  AUDIT_TYPE.UNBAN,
  AUDIT_TYPE.KICK,
  AUDIT_TYPE.MUTE,
  AUDIT_TYPE.UNMUTE,
  AUDIT_TYPE.BAN_ALL,
  AUDIT_TYPE.UNBAN_ALL,
] as const

/** Why the actor was allowed to act (RFC v3 §9.2, §10.2). */
export const AUDIT_BASIS = {
  IDP_PERMISSION: "idp_permission",
  TELEGRAM_CHAT_ADMIN: "telegram_chat_admin",
  AUTOMATIC: "automatic",
  TELEGRAM_UI: "telegram_ui",
  /** Rows written before the IdP migration, or by legacy callers. */
  LEGACY: "legacy",
} as const
export type TAuditBasis = (typeof AUDIT_BASIS)[keyof typeof AUDIT_BASIS]

/** Why a recorded action needs a human look; null when it is consistent. */
export const AUDIT_REVIEW = {
  /** `idp_permission`, but the actor did not hold the permission in the snapshot. */
  PERMISSION_MISSING: "permission_missing",
  /** `idp_permission`, but the snapshot was stale, so the claim could not be checked. */
  UNVERIFIED: "unverified",
} as const
export type TAuditReview = (typeof AUDIT_REVIEW)[keyof typeof AUDIT_REVIEW]

export const auditLog = createTable.tg(
  "audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    /** Superseded by `actorTgId`; still written for readers of the old shape. */
    adminId: bigint("admin_id", { mode: "number" }),
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    groupId: bigint("group_id", { mode: "number" }),
    type: varchar("type", { length: 32 }).$type<TAuditType>().notNull(),
    until: timestamp("until", { precision: 0, withTimezone: true }),
    reason: varchar("reason", { length: 256 }),
    actorSub: text("actor_sub"),
    actorTgId: bigint("actor_tg_id", { mode: "number" }),
    /** The OAuth client that executed the action, e.g. `telegram-bot`; null for legacy rows. */
    client: text("client"),
    basis: varchar("basis", { length: 32 }).$type<TAuditBasis>().notNull().default(AUDIT_BASIS.LEGACY),
    review: varchar("review", { length: 32 }).$type<TAuditReview>(),
    /** Makes the bot's retries safe: a repeated key records nothing. */
    idempotencyKey: text("idempotency_key"),

    ...timeColumns,
  },
  (t) => [
    index("auditlog_adminid_idx").on(t.adminId),
    index("auditlog_actor_tg_id_idx").on(t.actorTgId),
    uniqueIndex("auditlog_idempotency_key_idx").on(t.idempotencyKey),
  ]
)
