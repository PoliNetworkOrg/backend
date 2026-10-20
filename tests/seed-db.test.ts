import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { beforeAll, beforeEach, describe, expect, it } from "vitest"

const exec = promisify(execFile)
const testPort = process.env.SEED_TEST_DB_PORT
const seedEnv = {
  PATH: process.env.PATH,
  NODE_ENV: "test",
  DB_HOST: "127.0.0.1",
  DB_PORT: testPort,
  DB_USER: "seed_test",
  DB_PASS: "seed_test",
  DB_NAME: "seed_review_test",
  BETTER_AUTH_SECRET: "seed-test-secret-with-at-least-thirty-two-characters",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
}

/** Runs the production CLI against the disposable integration database. */
async function seed(force = false) {
  return exec("bun", ["scripts/seed-db.ts", ...(force ? ["--force"] : [])], { env: seedEnv })
}

/** Uses a Bun subprocess so Vitest can query PostgreSQL with the production SQL driver. */
async function query(sql: string): Promise<Record<string, unknown>[]> {
  const { stdout } = await exec(
    "bun",
    [
      "-e",
      `import { SQL } from "bun";
      const db = new SQL({ hostname: process.env.DB_HOST, port: Number(process.env.DB_PORT),
        username: process.env.DB_USER, password: process.env.DB_PASS, database: process.env.DB_NAME });
      console.log(JSON.stringify(await db.unsafe(process.argv[1])));
      await db.close();`,
      sql,
    ],
    { env: seedEnv }
  )
  return JSON.parse(stdout)
}

// The port opts into a disposable PostgreSQL database with the fixed test credentials above.
describe.skipIf(!testPort)("database seed", () => {
  beforeAll(async () => {
    await seed()
  }, 30_000)

  beforeEach(async () => {
    await query(`DO $$ DECLARE tables text; BEGIN
      SELECT string_agg(quote_ident(tablename), ', ') INTO tables FROM pg_tables WHERE schemaname = 'public';
      EXECUTE 'TRUNCATE ' || tables || ' RESTART IDENTITY CASCADE';
    END $$`)
  })

  it("seeds missing groups and messages without granting privileges to retained users", async () => {
    await query(`INSERT INTO tg_users (user_id, first_name, is_bot) VALUES (100000001, 'retained', false)`)

    await seed()

    expect(await query("SELECT user_id, first_name FROM tg_users")).toEqual([
      { user_id: "100000001", first_name: "retained" },
    ])
    expect(await query("SELECT count(*)::int AS count FROM tg_groups")).toEqual([{ count: 1006 }])
    expect(await query("SELECT DISTINCT author_id FROM tg_messages")).toEqual([{ author_id: "100000001" }])
    expect(await query("SELECT count(*)::int AS count FROM tg_messages")).toEqual([{ count: 30 }])
    expect(await query("SELECT * FROM tg_permissions WHERE user_id = 100000001")).toEqual([])
    expect(await query("SELECT * FROM tg_group_admins")).toEqual([])
    expect(await query("SELECT * FROM tg_grants_v2")).toEqual([])
    expect(await query("SELECT DISTINCT target_id FROM tg_audit_log")).toEqual([{ target_id: "100000001" }])
  }, 30_000)

  it("uses retained groups for messages without assigning their admins", async () => {
    await query(`INSERT INTO tg_groups (telegram_id, title) VALUES (-1000000000001, 'retained')`)

    await seed()

    expect(await query("SELECT title FROM tg_groups WHERE telegram_id = -1000000000001")).toEqual([
      { title: "retained" },
    ])
    expect(await query("SELECT count(*)::int AS count FROM tg_groups")).toEqual([{ count: 7 }])
    expect(await query("SELECT DISTINCT chat_id FROM tg_messages")).toEqual([{ chat_id: "-1000000000001" }])
    expect(await query("SELECT * FROM tg_group_admins")).toEqual([])
    expect(await query("SELECT count(*)::int AS count FROM tg_permissions WHERE user_id <> 1")).toEqual([{ count: 7 }])
  }, 30_000)

  it("fills empty users and groups while preserving existing messages", async () => {
    await query(`INSERT INTO tg_messages (chat_id, message_id, author_id, timestamp, message)
      VALUES (-42, 1, 42, now(), 'retained')`)

    await seed()

    expect(await query("SELECT chat_id, message_id, author_id, message FROM tg_messages")).toEqual([
      { chat_id: "-42", message_id: "1", author_id: "42", message: "retained" },
    ])
    expect(await query("SELECT count(*)::int AS count FROM tg_users")).toEqual([{ count: 2000 }])
    expect(await query("SELECT count(*)::int AS count FROM tg_groups")).toEqual([{ count: 1006 }])
  }, 30_000)

  it("does not assign roles, admins, or grants when Telegram activity already exists", async () => {
    await query(`INSERT INTO tg_users (user_id, first_name, is_bot) VALUES (100000001, 'retained', false);
      INSERT INTO tg_groups (telegram_id, title) VALUES (-1000000000001, 'retained');
      INSERT INTO tg_messages (chat_id, message_id, author_id, timestamp, message)
        VALUES (-1000000000001, 1, 100000001, now(), 'retained')`)

    await seed()

    expect(await query("SELECT * FROM tg_permissions WHERE user_id <> 1")).toEqual([])
    expect(await query("SELECT * FROM tg_group_admins")).toEqual([])
    expect(await query("SELECT * FROM tg_grants_v2")).toEqual([])
    expect(await query("SELECT count(*)::int AS count FROM tg_messages")).toEqual([{ count: 1 }])
  }, 30_000)

  it.each([false, true])("reconciles FAQ categories with a matching category present: %s", async (matching) => {
    await query(`INSERT INTO web_faq_categories (title_it, title_en, created_by_sub)
      VALUES ('Custom', 'Custom', 'retained')`)
    if (matching) {
      await query(`INSERT INTO web_faq_categories (title_it, title_en, created_by_sub)
        VALUES ('Gruppi', 'Existing groups', 'retained')`)
    }

    await seed()

    expect(await query("SELECT count(*)::int AS count FROM web_faqs")).toEqual([{ count: 9 }])
    expect(await query("SELECT count(*)::int AS count FROM web_faq_categories")).toEqual([{ count: 5 }])
    expect(await query("SELECT title_en FROM web_faq_categories WHERE title_it = 'Custom'")).toEqual([
      { title_en: "Custom" },
    ])
    if (matching) {
      expect(await query("SELECT title_en FROM web_faq_categories WHERE title_it = 'Gruppi'")).toEqual([
        { title_en: "Existing groups" },
      ])
      expect(await query("SELECT count(*)::int AS count FROM web_faqs WHERE category_id = 2")).toEqual([{ count: 3 }])
    }
  }, 30_000)

  it("preserves samples on reruns and replaces populated sample tables with --force", async () => {
    await seed()
    const counts = async () =>
      query(`SELECT 'users' AS name, count(*)::int AS count FROM tg_users
        UNION ALL SELECT 'messages', count(*)::int FROM tg_messages
        UNION ALL SELECT 'staff', count(*)::int FROM tg_permissions WHERE user_id <> 1
        UNION ALL SELECT 'admins', count(*)::int FROM tg_group_admins
        UNION ALL SELECT 'faqs', count(*)::int FROM web_faqs
        UNION ALL SELECT 'grants', count(*)::int FROM tg_grants_v2
        ORDER BY name`)
    const expected = [
      { name: "admins", count: 12 },
      { name: "faqs", count: 9 },
      { name: "grants", count: 11 },
      { name: "messages", count: 60000 },
      { name: "staff", count: 7 },
      { name: "users", count: 2000 },
    ]
    expect(await counts()).toEqual(expected)
    const fingerprints = async () =>
      query(`SELECT tablename, data AS fingerprint FROM (
        SELECT 'tg_messages' AS tablename, md5(string_agg(row_to_json(m)::text, ',' ORDER BY chat_id, message_id)) AS data
          FROM tg_messages m
        UNION ALL SELECT 'web_faqs', md5(string_agg(row_to_json(f)::text, ',' ORDER BY id)) FROM web_faqs f
        UNION ALL SELECT 'tg_grants_v2', md5(string_agg(row_to_json(g)::text, ',' ORDER BY id)) FROM tg_grants_v2 g
      ) t ORDER BY tablename`)
    const before = await fingerprints()

    await seed()

    expect(await counts()).toEqual(expected)
    expect(await fingerprints()).toEqual(before)

    await query(`UPDATE tg_users SET first_name = 'replace-me';
      UPDATE web_faq_categories SET title_it = 'replace-me';
      UPDATE web_projects SET title = 'replace-me'`)
    await seed(true)

    expect(await counts()).toEqual(expected)
    expect(await query("SELECT * FROM tg_users WHERE first_name = 'replace-me'")).toEqual([])
    expect(await query("SELECT * FROM web_faq_categories WHERE title_it = 'replace-me'")).toEqual([])
    expect(await query("SELECT * FROM web_projects WHERE title = 'replace-me'")).toEqual([])
  }, 30_000)
})
