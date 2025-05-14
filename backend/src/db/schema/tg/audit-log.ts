import { timeColumns } from "@/db/columns";
import { createTable } from "../create-table";
import { bigint, index, integer, timestamp, varchar } from "drizzle-orm/pg-core";

export const AUDIT_TYPE = {
  BAN: "ban",
  KICK: "kick",
  MUTE: "mute",
  BAN_ALL: "ban_all",
  MUTE_ALL: "mute_all",
} as const;
export type TAuditType = (typeof AUDIT_TYPE)[keyof typeof AUDIT_TYPE];

export const ARRAY_AUDIT_TYPE = [
  AUDIT_TYPE.BAN,
  AUDIT_TYPE.KICK,
  AUDIT_TYPE.MUTE,
  AUDIT_TYPE.BAN_ALL,
  AUDIT_TYPE.MUTE_ALL,
] as const;

export const auditLog = createTable.tg(
  "audit_log",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    adminId: bigint("admin_id", { mode: "number" }).notNull(),
    targetId: bigint("target_id", { mode: "number" }).notNull(),
    groupId: bigint("group_id", { mode: "number" }),
    type: varchar("type", { length: 32 }).$type<TAuditType>().notNull(),
    until: timestamp("until", { precision: 0 }),
    reason: varchar("reason", { length: 256 }),

    ...timeColumns,
  },
  (t) => [index("auditlog_adminid_idx").on(t.adminId)],
);
