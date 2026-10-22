import { readFile } from "node:fs/promises"
import { getTableConfig } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { messages } from "@/db/schema/tg/messages"

describe("Telegram message lookup index", () => {
  it("matches the chat-scoped newest-message query", async () => {
    const index = getTableConfig(messages).indexes.find(
      (candidate) => candidate.config.name === "tg_messages_chat_author_timestamp_idx"
    )

    expect(index).toBeDefined()
    expect(
      index?.config.columns.map((column) => ({
        name: "name" in column ? column.name : undefined,
        nulls: "indexConfig" in column ? column.indexConfig?.nulls : undefined,
        order: "indexConfig" in column ? column.indexConfig?.order : undefined,
      }))
    ).toEqual([
      { name: "chat_id", nulls: "last", order: "asc" },
      { name: "author_id", nulls: "last", order: "asc" },
      { name: "timestamp", nulls: "last", order: "desc" },
    ])

    const migration = await readFile(new URL("../drizzle/0016_telegram_message_lookup.sql", import.meta.url), "utf8")
    expect(migration.trim()).toBe(
      'CREATE INDEX "tg_messages_chat_author_timestamp_idx" ON "tg_messages" USING btree ("chat_id","author_id","timestamp" DESC NULLS LAST);'
    )
  })
})
