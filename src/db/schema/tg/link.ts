import { bigint, integer, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { user } from "../auth/auth"
import { createTable } from "../create-table"

export const link = createTable.tg("link", {
  code: text("code").primaryKey(),
  ttl: integer("ttl").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id),
  telegramUsername: text("tg_username").notNull(),
  telegramId: bigint("tg_id", { mode: "number" }).unique(),

  ...timeColumns,
})
