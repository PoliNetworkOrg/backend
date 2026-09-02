import { bigint, index, integer, timestamp, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const AUDIT_TYPE = {
  BAN: "ban",
  UNBAN: "unban",
  KICK: "kick",
  MUTE: "mute",
  UNMUTE: "unmute",
  DELETE: "delete",
  MULTI_CHAT_SPAM: "multi_chat_spam",
  BAN_ALL: "ban_all",
  UNBAN_ALL: "unban_all",
} as const
export type TAuditType = (typeof AUDIT_TYPE)[keyof typeof AUDIT_TYPE]

export const AUDIT_STATUS = {
  PENDING: "pending",
  RUNNING: "running",
  COMPLETED: "completed",
  PARTIAL: "partial",
  FAILED: "failed",
} as const
export type TAuditStatus = (typeof AUDIT_STATUS)[keyof typeof AUDIT_STATUS]

export const ARRAY_AUDIT_TYPE = [
  AUDIT_TYPE.BAN,
  AUDIT_TYPE.UNBAN,
  AUDIT_TYPE.KICK,
  AUDIT_TYPE.MUTE,
  AUDIT_TYPE.UNMUTE,
  AUDIT_TYPE.DELETE,
  AUDIT_TYPE.MULTI_CHAT_SPAM,
  AUDIT_TYPE.BAN_ALL,
  AUDIT_TYPE.UNBAN_ALL,
] as const

export const ARRAY_AUDIT_STATUS = [
  AUDIT_STATUS.PENDING,
  AUDIT_STATUS.RUNNING,
  AUDIT_STATUS.COMPLETED,
  AUDIT_STATUS.PARTIAL,
  AUDIT_STATUS.FAILED,
] as const

export const auditLog = createTable.tg(
  "audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    adminId: bigint("admin_id", { mode: "number" }).notNull(),
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    groupId: bigint("group_id", { mode: "number" }),
    type: varchar("type", { length: 32 }).$type<TAuditType>().notNull(),
    status: varchar("status", { length: 32 }).$type<TAuditStatus>().notNull().default(AUDIT_STATUS.COMPLETED),
    until: timestamp("until", { precision: 0, withTimezone: true }),
    reason: varchar("reason", { length: 256 }),
    deletedMessageCount: integer("deleted_message_count").default(0),
    totalGroupCount: integer("total_group_count").notNull().default(0),
    successGroupCount: integer("success_group_count").notNull().default(0),
    failedGroupCount: integer("failed_group_count").notNull().default(0),

    ...timeColumns,
  },
  (t) => [
    index("auditlog_adminid_idx").on(t.adminId),
    index("auditlog_targetid_idx").on(t.targetId),
    index("auditlog_createdat_idx").on(t.createdAt),
  ]
)
