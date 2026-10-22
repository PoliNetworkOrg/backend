import { bigint, boolean, varchar } from "drizzle-orm/pg-core"
import { timeColumns } from "@/db/columns"
import { createTable } from "../create-table"

export const users = createTable.tg("users", {
  userId: bigint("user_id", { mode: "number" }).primaryKey(),
  // A 64-code-unit Unicode name can use 192 UTF-8 bytes and 442 encrypted hex characters.
  firstName: varchar("first_name", { length: 512 }).notNull(),
  lastName: varchar("last_name", { length: 512 }),
  username: varchar("username", { length: 128 }), // 122
  isBot: boolean("is_bot").notNull(),

  // https://stackoverflow.com/questions/17848070/what-data-type-should-i-use-for-ietf-language-codes
  // how 35? idk
  langCode: varchar("lang_code", { length: 35 }),

  ...timeColumns,
})
