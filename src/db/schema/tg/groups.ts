import { bigint, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const groups = createTable.tg("groups", {
  telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
  title: varchar("title").notNull(),
  link: varchar("link", { length: 128 }),

  ...timeColumns,
})
