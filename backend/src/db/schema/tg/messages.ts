import { timeColumns } from "@/db/columns";
import { createTable } from "../create-table";
import { bigint, primaryKey, timestamp, varchar } from "drizzle-orm/pg-core";

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
    timestamp: timestamp("timestamp").notNull(), // the telegram message timestamp
    message: varchar("message", { length: 8704 }).notNull(),
    createdAt: timeColumns.createdAt,
  },
  (t) => [primaryKey({ columns: [t.chatId, t.messageId] })],
);
