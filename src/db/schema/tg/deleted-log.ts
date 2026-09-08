import { bigint, index, integer, jsonb, timestamp, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const deletedLog = createTable.tg(
  "log_deleted",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Message info
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    chatId: bigint("chat_id", { mode: "number" }).notNull(),

    // Who wrote the message
    authorId: bigint("author_id", { mode: "number" }).notNull(),
    author: jsonb("author").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Who deleted it (moderator or bot)
    deletedById: bigint("deleted_by_id", { mode: "number" }).notNull(),
    deletedBy: jsonb("deleted_by").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>().notNull(),

    // When it was deleted
    deletedAt: timestamp("deleted_at", { precision: 0, withTimezone: true }).notNull(),

    // Why
    reason: varchar("reason", { length: 256 }),

    // Source
    source: varchar("source", { length: 64 }).default("moderation").notNull(), // "moderation" | "auto" | "manual"

    // Pre-deletion info
    preDeleteRes: jsonb("pre_delete_res").$type<{
      count: number
      logMessageIds: number[]
      link?: string
    } | null>(),

    ...timeColumns,
  },
  (t) => [
    index("log_deleted_chat_id_idx").on(t.chatId),
    index("log_deleted_author_id_idx").on(t.authorId),
    index("log_deleted_deleted_by_id_idx").on(t.deletedById),
    index("log_deleted_deleted_at_idx").on(t.deletedAt),
  ]
)