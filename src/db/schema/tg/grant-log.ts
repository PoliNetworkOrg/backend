import { index, integer, jsonb, timestamp, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"
import type { TGrantActionType } from "@/routers/tg/types"

export const grantLog = createTable.tg(
  "log_grant",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),

    // Action type
    action: varchar("action", { length: 32 }).$type<TGrantActionType>().notNull(),

    // Who triggered (for usage)
    from: jsonb("from_user").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Message (for usage)
    message: jsonb("message").$type<{
      message_id: number
      date: number
      chat: { id: number; type: string; title?: string; username?: string }
      from: { id: number; is_bot: boolean; first_name: string; last_name?: string; username?: string; language_code?: string }
      text?: string
    }>(),

    // Chat context
    chat: jsonb("chat").$type<{
      id: number
      type: string
      title?: string
      username?: string
    }>(),

    // Target user
    target: jsonb("target").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Who created/interrupted
    by: jsonb("by_user").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Time range
    since: timestamp("since", { precision: 0, withTimezone: true }),
    until: timestamp("until", { precision: 0, withTimezone: true }),

    // Why
    reason: varchar("reason", { length: 256 }),

    // Who interrupted
    interruptedBy: jsonb("interrupted_by").$type<{
      id: number
      is_bot: boolean
      first_name: string
      last_name?: string
      username?: string
      language_code?: string
    }>(),

    // Source
    source: varchar("source", { length: 64 }).default("bot").notNull(),

    ...timeColumns,
  },
  (t) => [
    index("log_grant_action_idx").on(t.action),
    index("log_grant_target_id_idx").on(t.target),
  ]
)