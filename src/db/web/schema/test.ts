import { integer, pgTable, varchar } from "drizzle-orm/pg-core";

export const testTable = pgTable("test", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  text: varchar("text").notNull()
});
