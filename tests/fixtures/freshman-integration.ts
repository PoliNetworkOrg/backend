import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import type { Context } from "@/trpc"

// Only the explicit disposable test port is accepted; application database configuration is never used.
const port = Number(process.env.FRESHMAN_TEST_DB_PORT)
if (!Number.isInteger(port) || port < 10000)
  throw new Error("Set FRESHMAN_TEST_DB_PORT to an isolated PostgreSQL port >= 10000.")
const database = `freshman_api_test_${crypto.randomUUID().replaceAll("-", "")}`
const config = { hostname: "127.0.0.1", port, username: "freshman_test", password: "freshman_test" }
const admin = new SQL({ ...config, database: "postgres" })
const previousMigrations = await mkdtemp(join(tmpdir(), "freshman-migrations-"))
await admin.unsafe(`CREATE DATABASE "${database}"`)
const connection = new SQL({ ...config, database })
let closeBackend: (() => Promise<void>) | undefined
try {
  const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")) as {
    entries: Array<{ tag: string }>
  }
  const previous = { ...journal, entries: journal.entries.filter((entry) => entry.tag !== "0022_freshman_content") }
  await import("node:fs/promises").then(({ mkdir }) => mkdir(join(previousMigrations, "meta")))
  await writeFile(join(previousMigrations, "meta/_journal.json"), JSON.stringify(previous))
  for (const entry of previous.entries)
    await writeFile(join(previousMigrations, `${entry.tag}.sql`), await readFile(`drizzle/${entry.tag}.sql`))
  await migrate(drizzle(connection), { migrationsFolder: previousMigrations })
  const [category] =
    await connection`INSERT INTO web_faq_categories (title_it, title_en, created_by_sub) VALUES ('Existing', 'Existing', 'retained') RETURNING id`
  const title = "Le lezioni della prima settimana si tengono regolarmente?"
  const [retained] =
    await connection`INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub) VALUES (${title}, 'Retained English', 'Retained answer', 'Retained English answer', ${category.id}, 'retained') RETURNING id`

  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_HOST: "127.0.0.1",
    DB_PORT: String(port),
    DB_USER: config.username,
    DB_PASS: config.password,
    DB_NAME: database,
    BETTER_AUTH_SECRET: "freshman-test-secret-at-least-thirty-two-characters",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  })
  const { DB } = await import("@/db") // Runs the new migration through the actual application entry point.
  closeBackend = () => DB.$client.close()
  const freshman = (await import("@/routers/web/freshman")).default
  const faqs = (await import("@/routers/web/faqs")).default
  const editorContext: Context = {
    auth: {
      kind: "token",
      actor: { kind: "user", sub: "freshman-editor", client: "admin", telegramId: null },
      scopes: new Set(["backend:admin"]),
    },
    access: {
      has: () => true,
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ lastSyncAt: 1, fresh: true, generation: 1, subjects: 1 }),
    },
  }
  const editor = freshman.createCaller(editorContext)
  const catalog = faqs.createCaller(editorContext)
  const website = freshman.createCaller({
    auth: { kind: "token", actor: { kind: "service", client: "website" }, scopes: new Set(["backend:public:read"]) },
  })
  const before = await website.getContent()
  assert.equal(before.resources.length, 10)
  assert.equal(before.telegram.length, 8)
  assert.equal(before.faqs.length, 5)
  assert.equal(before.faqs[0].faqId, retained.id)
  assert.equal(before.faqs[0].descriptionIt, "Retained answer")
  assert.equal(before.faqs[0].titleEn, "Retained English")
  assert.equal("modifiedBySub" in before.resources[0], false)

  const card = before.resources[0]
  const fields = {
    title: "Updated graduation resource",
    description: card.description,
    icon: card.icon,
    href: "https://example.org/new",
  }
  await editor.updateCard({ id: card.id, ...fields, modifiedBy: 999 })
  assert.equal((await website.getContent()).resources[0].title, fields.title)
  assert.deepEqual(
    (await connection`SELECT modified_by_id, modified_by_sub FROM web_freshman_cards WHERE id = ${card.id}`)[0],
    { modified_by_id: null, modified_by_sub: "freshman-editor" }
  )
  for (const href of ["javascript:alert(1)", "//example.org", "/\\example.org"])
    await assert.rejects(editor.updateCard({ id: card.id, ...fields, href }), { code: "BAD_REQUEST" })
  await assert.rejects(editor.moveCard({ id: "featured-2", direction: 1 }), { code: "BAD_REQUEST" })
  await assert.rejects(editor.selectFaq({ position: 0, faqId: 2_000_000_000 }), { code: "NOT_FOUND" })

  // Pause deletion on a catalog row, then race it with selecting that same FAQ.
  // Observe PostgreSQL locks instead of relying on timing or arbitrary sleeps.
  async function waitFor(condition: () => Promise<boolean>) {
    const deadline = Date.now() + 5000
    while (!(await condition())) {
      assert.ok(Date.now() < deadline, "timed out waiting for the database lock")
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  for (const target of ["faq", "category"] as const) {
    const [raceCategory] =
      await connection`INSERT INTO web_faq_categories (title_it, title_en, created_by_sub) VALUES ('Race', 'Race', 'test') RETURNING id`
    const [raceFaq] =
      await connection`INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub) VALUES ('Race', 'Race', 'Answer', 'Answer', ${raceCategory.id}, 'test') RETURNING id`
    const blocker = new SQL({ ...config, database, max: 1 })
    try {
      await blocker.unsafe("BEGIN")
      await blocker`SELECT id FROM web_faqs WHERE id = ${raceFaq.id} FOR NO KEY UPDATE`
      const deletion =
        target === "faq" ? catalog.deleteFaqs({ id: raceFaq.id }) : catalog.deleteFaqsCategory({ id: raceCategory.id })
      const deletionResult = Promise.allSettled([deletion])
      await waitFor(
        async () =>
          (
            await connection`SELECT 1 FROM pg_stat_activity WHERE datname = ${database} AND wait_event_type = 'Lock' AND query ILIKE 'delete%'`
          ).length > 0
      )
      let selectionFinished = false
      const selectionResult = Promise.allSettled([editor.selectFaq({ position: 0, faqId: raceFaq.id })]).then(
        (result) => {
          selectionFinished = true
          return result
        }
      )
      await waitFor(
        async () =>
          selectionFinished ||
          (
            await connection`SELECT 1 FROM pg_stat_activity WHERE datname = ${database} AND wait_event_type = 'Lock' AND query ILIKE '%web_freshman_faqs%'`
          ).length > 0
      )
      await blocker.unsafe("COMMIT")
      const [deleted] = await deletionResult
      const [selected] = await selectionResult
      assert.equal(deleted.status, "fulfilled", `concurrent ${target} deletion must return a domain result`)
      if (deleted.status === "fulfilled" && deleted.value.error === null) {
        assert.equal(selected.status, "rejected")
        if (selected.status === "rejected") assert.equal(selected.reason.code, "NOT_FOUND")
      } else {
        assert.equal(deleted.status === "fulfilled" && deleted.value.error, "FEATURED_FAQ")
        assert.equal(selected.status, "fulfilled")
      }
      await editor.selectFaq({ position: 0, faqId: before.faqs[0].faqId })
      assert.equal((await website.getContent()).faqs.length, 5)
    } finally {
      await blocker.unsafe("ROLLBACK")
      await blocker.close()
    }
  }

  // The migration must match the immediate uniqueness declared by the Drizzle schema.
  const [constraint] =
    await connection`SELECT condeferrable FROM pg_constraint WHERE conrelid = 'web_freshman_faqs'::regclass AND conname = 'web_freshman_faqs_faq_id_unique'`
  assert.equal(constraint.condeferrable, false)
  const originalSlots =
    await connection`SELECT position, created_at, created_by_sub FROM web_freshman_faqs ORDER BY position`
  await editor.selectFaq({ position: 0, faqId: before.faqs[1].faqId })
  await editor.selectFaq({ position: 0, faqId: before.faqs[0].faqId })
  assert.deepEqual(
    await connection`SELECT position, created_at, created_by_sub FROM web_freshman_faqs ORDER BY position`,
    originalSlots,
    "swaps must retain slot creation metadata"
  )

  const changed = await website.getContent()
  await Promise.all(Array.from({ length: 12 }, () => editor.moveCard({ id: "featured-1", direction: 1 })))
  assert.deepEqual(
    (await website.getContent()).resources,
    changed.resources,
    "an even number of concurrent swaps must preserve contents"
  )
  await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      editor.selectFaq({ position: index % 2, faqId: before.faqs[(index % 2) + 2].faqId })
    )
  )
  const swapped = await website.getContent()
  assert.equal(swapped.faqs.length, 5)
  assert.equal(new Set(swapped.faqs.map((faq) => faq.faqId)).size, 5)
  assert.deepEqual(new Set(swapped.faqs.map((faq) => faq.faqId)), new Set(before.faqs.map((faq) => faq.faqId)))

  await catalog.editFaqs({
    id: retained.id,
    titleIt: title,
    titleEn: "Updated English",
    descriptionIt: "Updated Italian answer",
    descriptionEn: "Updated English answer",
    categoryId: category.id,
  })
  assert.equal(
    (await website.getContent()).faqs.find((faq) => faq.faqId === retained.id)?.descriptionIt,
    "Updated Italian answer"
  )
  assert.deepEqual(await catalog.deleteFaqs({ id: retained.id }), { error: "FEATURED_FAQ" })
  assert.deepEqual(await catalog.deleteFaqsCategory({ id: category.id }), { error: "FEATURED_FAQ" })
  await assert.rejects(connection`DELETE FROM web_faqs WHERE id = ${retained.id}`, {
    errno: "23001",
    constraint: "web_freshman_faqs_faq_id_web_faqs_id_fk",
  })

  const [extra] =
    await connection`INSERT INTO web_faqs (title_it, title_en, description_it, description_en, category_id, created_by_sub) VALUES ('New choice', 'New choice', 'New answer', 'New answer', ${category.id}, 'test') RETURNING id`
  await editor.selectFaq({ position: 0, faqId: extra.id })
  const after = await website.getContent()
  assert.equal(after.faqs[0].faqId, extra.id)
  assert.equal(new Set(after.faqs.map((faq) => faq.faqId)).size, 5)
  assert.equal((await connection`SELECT count(*)::int AS count FROM web_freshman_cards`)[0].count, 18)
  assert.equal((await connection`SELECT count(*)::int AS count FROM web_freshman_faqs`)[0].count, 5)
  console.log(
    "PASS: migration FAQ reuse, fixed counts, public reads, durable writes, authorship, invalid inputs, concurrent swaps, catalog propagation and deletion protection"
  )
} finally {
  await closeBackend?.()
  await connection.close()
  await admin.unsafe(`DROP DATABASE "${database}"`)
  await admin.close()
  await rm(previousMigrations, { recursive: true })
}
