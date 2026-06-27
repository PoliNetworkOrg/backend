import { bigint, index, integer, timestamp, varchar, boolean } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createTable } from "../create-table";

export const warnings = createTable.tg(
    "warnings",
    {
        id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
        targetId: bigint("target_id", { mode: "number" }).notNull(),
        adminId: bigint("admin_id", { mode: "number" }).notNull(),
        groupId: bigint("group_id", { mode: "number" }).notNull(),
        reason: varchar("reason", { length: 256 }),
        isExpired: boolean("is_expired").default(false).notNull(),
        deletedAt: timestamp("deleted_at", { precision: 0, withTimezone: true }),
        createdAt: timestamp("created_at", { precision: 0, withTimezone: true}).default(sql`now()`).notNull()
    },
    (t) => [index("warnings_target_idx").on(t.targetId)]
)