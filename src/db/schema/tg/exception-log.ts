import { index, integer, jsonb, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const exceptionLog = createTable.tg(
  "log_exception",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Exception type
    type: varchar("type", { length: 64 }).notNull(),

    // Error details
    error: jsonb("error").notNull(),

    // Context where exception occurred
    context: jsonb("context"),

    // Source
    source: varchar("source", { length: 64 }).default("bot").notNull(),

    ...timeColumns,
  },
  (t) => [
    index("log_exception_type_idx").on(t.type),
    index("log_exception_created_at_idx").on(t.createdAt),
  ]
)