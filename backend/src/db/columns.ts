import { sql } from "drizzle-orm";
import { timestamp } from "drizzle-orm/pg-core";

export const timeColumns = {
    updatedAt: timestamp("updated_at", { precision: 3 }).$onUpdate(
      () => sql`now()`,
    ),
    createdAt: timestamp("created_at", { precision: 3 })
      .default(sql`now()`)
      .notNull(),
}
