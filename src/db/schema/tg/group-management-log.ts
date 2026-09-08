import { index, integer, jsonb, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import type { TGroupManagementActionType } from "@/routers/tg/types"

export const groupManagementLog = createTable.tg(
  "log_group_management",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Action type
    type: varchar("type", { length: 64 }).$type<TGroupManagementActionType>().notNull(),

    // Chat info
    chat: jsonb("chat").$type<{
      id: number
      type: string
      title?: string
      username?: string
    }>(),

    // Who added/requested
    addedBy: jsonb("added_by").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Invite link
    inviteLink: varchar("invite_link", { length: 256 }),

    // Why
    reason: varchar("reason", { length: 256 }),

    // Who requested
    requestedBy: jsonb("requested_by").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Stats for regenerate links
    total: integer("total"),
    regenerated: integer("regenerated"),
    synchronized: integer("synchronized"),
    failures: jsonb("failures").$type<Array<{
      telegramId: number
      title: string
      stage: "TELEGRAM" | "BACKEND"
      reason: string
    }>>(),

    // Source
    source: varchar("source", { length: 64 }).default("bot").notNull(),

    ...timeColumns,
  },
  (t) => [
    index("log_group_management_type_idx").on(t.type),
    index("log_group_management_created_at_idx").on(t.createdAt),
  ]
)