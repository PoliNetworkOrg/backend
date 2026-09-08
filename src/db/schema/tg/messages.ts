import { bigint, index, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const messages = createTable.tg(
  "messages",
  {
    chatId: bigint("chat_id", {
      mode: "number",
    }).notNull(),
    messageId: bigint("message_id", {
      mode: "number",
    }).notNull(),
    authorId: bigint("author_id", { mode: "number" }).notNull(),
    timestamp: timestamp("timestamp", { precision: 0, withTimezone: true }).notNull(), // the telegram message timestamp
    message: varchar("message", { length: 8704 }).notNull(),
    deletedAt: timestamp("deleted_at", { precision: 0, withTimezone: true }),
    createdAt: timeColumns.createdAt,
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.messageId] }),
    index("tg_messages_chat_author_timestamp_idx").on(t.chatId, t.authorId, t.timestamp.desc()),
    index("tg_messages_deleted_at_idx").on(t.deletedAt),
  ]
)
