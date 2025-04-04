import { integer, varchar } from "drizzle-orm/pg-core";
import { createTable } from "../create-table";

export const test = createTable.tg("test", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  text: varchar("text").notNull(),
});
