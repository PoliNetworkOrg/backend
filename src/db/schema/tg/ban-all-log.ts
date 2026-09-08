import { bigint, index, integer, jsonb, timestamp, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import type { TBanAllActionType } from "@/routers/tg/types"

export const banAllLog = createTable.tg(
  "log_ban_all",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Who initiated the ban all
    adminId: bigint("admin_id", { mode: "number" }).notNull(),
    admin: jsonb("admin").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>().notNull(),

    // Target user to ban/unban across all groups
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    target: jsonb("target").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>().notNull(),

    // What action (ban_all | unban_all)
    type: varchar("type", { length: 32 }).$type<TBanAllActionType>().notNull(),

    // Why
    reason: varchar("reason", { length: 256 }),

    // Source
    source: varchar("source", { length: 64 }).default("manual").notNull(),

    // Progress tracking
    status: varchar("status", { length: 32 }).$type<"pending" | "running" | "completed" | "partial" | "failed">().default("pending").notNull(),
    totalGroupCount: integer("total_group_count").default(0).notNull(),
    successGroupCount: integer("success_group_count").default(0).notNull(),
    failedGroupCount: integer("failed_group_count").default(0).notNull(),
    deletedMessageCount: integer("deleted_message_count"),

    // Telegram log message ID for progress updates
    telegramLogMessageId: bigint("telegram_log_message_id", { mode: "number" }),

    ...timeColumns,
  },
  (t) => [
    index("log_ban_all_admin_id_idx").on(t.adminId),
    index("log_ban_all_target_id_idx").on(t.targetId),
    index("log_ban_all_status_idx").on(t.status),
  ]
)