import { sql } from "drizzle-orm";
import { timestamp } from "drizzle-orm/pg-core";

export const timeColumns = {
  updatedAt: timestamp("updated_at", { precision: 3 }).$onUpdate(
    () => new Date(),
  ),
  createdAt: timestamp("created_at", { precision: 3 })
    .default(sql`now()`)
    .notNull(),
};
