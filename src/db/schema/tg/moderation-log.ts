import { bigint, index, integer, jsonb, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import type { TModerationActionType } from "@/routers/tg/types"

export const MODERATION_AUDIT_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  PARTIAL: "partial",
  FAILED: "failed",
} as const
export type TModerationAuditStatus = (typeof MODERATION_AUDIT_STATUS)[keyof typeof MODERATION_AUDIT_STATUS]

export const moderationLog = createTable.tg(
  "log_moderation",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Who performed the action (moderator/admin)
    adminId: bigint("admin_id", { mode: "number" }).notNull(),
    admin: jsonb("admin").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>().notNull(),

    // Target user who was moderated
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    target: jsonb("target").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>().notNull(),

    // From where (chat/group context)
    chatId: bigint("chat_id", { mode: "number" }).notNull(),
    chat: jsonb("chat").$type<{
      id: number
      type: string
      title?: string
      username?: string
    }>().notNull(),

    // What action
    type: varchar("type", { length: 32 }).$type<TModerationActionType>().notNull(),

    // Duration for temp actions
    duration: jsonb("duration").$type<{
      raw: string
      date: string
      timestamp_s: number
      secondsFromNow: number
      dateStr: string
    }>(),

    // Why
    reason: varchar("reason", { length: 256 }),

    // Source/context
    source: varchar("source", { length: 64 }).default("manual").notNull(), // "manual" | "auto" | "chat_member_update"

    // Deletion info
    preDeleteRes: jsonb("pre_delete_res").$type<{
      count: number
      logMessageIds: number[]
      link?: string
    } | null>(),

    // Audit progress
    status: varchar("status", { length: 32 }).$type<TModerationAuditStatus>().default(MODERATION_AUDIT_STATUS.PENDING).notNull(),
    deletedMessageCount: integer("deleted_message_count"),
    totalGroupCount: integer("total_group_count").default(0).notNull(),
    successGroupCount: integer("success_group_count").default(0).notNull(),
    failedGroupCount: integer("failed_group_count").default(0).notNull(),

    ...timeColumns,
  },
  (t) => [
    index("log_moderation_admin_id_idx").on(t.adminId),
    index("log_moderation_target_id_idx").on(t.targetId),
    index("log_moderation_chat_id_idx").on(t.chatId),
    index("log_moderation_status_idx").on(t.status),
    index("log_moderation_type_idx").on(t.type),
  ]
)