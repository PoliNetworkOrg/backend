import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"

describe("production regressions", () => {
  it("expires Telegram link codes using the link table timestamp", async () => {
    const cron = await readFile(new URL("../src/cron.ts", import.meta.url), "utf8")

    expect(cron).toContain("lt(SCHEMA.TG.link.createdAt, yesterday)")
    expect(cron).not.toContain("lt(SCHEMA.TG.messages.createdAt, yesterday)")
  })

  it("does not print guide query results to stdout", async () => {
    const router = await readFile(new URL("../src/routers/web/guides_matricole.ts", import.meta.url), "utf8")

    expect(router).not.toContain("console.log(res, res[0])")
  })

  it("indexes the BanAll last-message lookup", async () => {
    const [schema, migration] = await Promise.all([
      readFile(new URL("../src/db/schema/tg/messages.ts", import.meta.url), "utf8"),
      readFile(new URL("../drizzle/0016_telegram_message_lookup.sql", import.meta.url), "utf8"),
    ])

    expect(schema).toContain("tg_messages_chat_author_timestamp_idx")
    expect(migration).toContain(
      'CREATE INDEX "tg_messages_chat_author_timestamp_idx" ON "tg_messages" USING btree ("chat_id","author_id","timestamp" DESC NULLS LAST)'
    )
  })
})
