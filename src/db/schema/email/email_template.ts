import { bigint, text } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import { permissions } from "../tg/permissions"

export const emailTemplateSchema = createTable.email("email_templates", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  createdBy: bigint("created_by_id", { mode: "number" })
    .references(() => permissions.userId)
    .notNull(),
  modifiedBy: bigint("modified_by_id", { mode: "number" }).references(() => permissions.userId),
  ...timeColumns,
})
