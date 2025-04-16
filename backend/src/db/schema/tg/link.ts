import { timeColumns } from "@/db/columns";
import { createTable } from "../create-table";
import { bigint, index, integer, text } from "drizzle-orm/pg-core";
import { users } from "../auth/auth";

export const link = createTable.tg(
  "link",
  {
    code: text("code").primaryKey(),
    ttl: integer("ttl").notNull(),
    userId: text("user_id").notNull().references(() => users.id),
    telegramUsername: text("tg_username").notNull(),
    telegramId: bigint("tg_id", { mode: "number" }),

    ...timeColumns,
  },
  (t) => [index("telegram_id_idx").on(t.telegramId)],
);
