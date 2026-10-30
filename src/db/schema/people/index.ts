import { index, jsonb, text } from "drizzle-orm/pg-core"
import type { PeopleState } from "@/people/types"
import { createTable } from "../create-table"

/** Small association metadata: one JSON row per person, outbox message or counter. */
export const records = createTable.people(
  "records",
  {
    id: text().primaryKey(),
    kind: text().$type<keyof PeopleState>().notNull(),
    data: jsonb().$type<unknown>().notNull(),
  },
  (t) => [index("people_records_kind_idx").on(t.kind)]
)

/** Unique identity constraints are relational, independent of the JSON projection. */
export const identities = createTable.people("identities", {
  personId: text("person_id").primaryKey(),
  accountSub: text("account_sub").unique(),
  telegramId: text("telegram_id").unique(),
})

export const schema = {
  peopleRecords: records,
  peopleIdentities: identities,
}
