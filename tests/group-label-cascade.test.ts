import { readFile } from "node:fs/promises"
import { expect, test } from "vitest"

test("deleting a group cascades to its label relations", async () => {
  const [tgSchema, waSchema, migration] = await Promise.all([
    readFile(new URL("../src/db/schema/tg/groups.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/db/schema/wa/groups.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0015_uneven_deathstrike.sql", import.meta.url), "utf8"),
  ])

  expect(tgSchema).toContain('.references(() => groups.telegramId, { onDelete: "cascade" })')
  expect(waSchema).toContain('.references(() => waGroups.id, { onDelete: "cascade" })')
  expect(migration).toContain('"tg_group_label_relations" DROP CONSTRAINT')
  expect(migration).toContain('"wa_group_label_relations" DROP CONSTRAINT')
  expect(migration.match(/ON DELETE cascade/g)).toHaveLength(2)
})
