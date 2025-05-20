import { timeColumns } from "@/db/columns";
import { createTable } from "../create-table";
import { bigint, varchar } from "drizzle-orm/pg-core";

export const groups = createTable.tg(
  "groups",
  {
    telegramId: bigint("telegram_id", { mode: "number" }).primaryKey(),
    title: varchar("title").notNull(),
    link: varchar("link", { length: 128 }),

    ...timeColumns,
  },
);
