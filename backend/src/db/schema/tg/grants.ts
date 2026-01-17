import { bigint, index, integer, text, timestamp } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "./permissions"

export const grants = createTable.tg(
  "grants",
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }),
    grantedBy: bigint("granted_by_id", { mode: "number" })
      .references(() => permissions.userId)
      .notNull(),
    validSince: timestamp("valid_since", { precision: 0 }).notNull(),
    validUntil: timestamp("valid_until", { precision: 0 }).notNull(),
    interruptedBy: bigint("interrupted_by_id", { mode: "number" }).references(() => permissions.userId),
    reason: text("reason"),

    ...timeColumns,
  },
  (t) => [index("tg_grants_user_id_idx").on(t.userId)]
)
