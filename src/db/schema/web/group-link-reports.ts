import { bigint, integer, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const groupLinkReportTypes = ["broken_link", "missing"] as const
export const groupLinkReportStatuses = ["pending", "resolved", "dismissed"] as const

export const groupLinkReports = createTable.web("group_link_reports", {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  groupId: bigint("group_id", { mode: "number" }).notNull(),
  type: varchar("type", { length: 2, enum: ["tg", "wa"] }).notNull(),
  reportType: varchar("report_type", { length: 32, enum: groupLinkReportTypes }).notNull(),
  reportedLink: varchar("reported_link", { length: 256 }),
  status: varchar("status", { length: 16, enum: groupLinkReportStatuses }).notNull().default("pending"),
  ...timeColumns,
})
