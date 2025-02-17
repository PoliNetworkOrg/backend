import { timeColumns } from "@/db/columns";
import {
  bigint,
  index,
  integer,
  pgTable,
  varchar,
} from "drizzle-orm/pg-core";

export const groups = pgTable(
  "groups",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    telegramId: bigint("telegram_id", { mode: "number" }).unique().notNull(),
    title: varchar("title").notNull(),
    link: varchar("link", { length: 128 }),

    ...timeColumns,
  },
  (t) => [index("telegram_id_idx").on(t.telegramId)],
);
