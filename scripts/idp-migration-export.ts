/**
 * IdP–Telegram migration, Phase 2 step 2 (RFC v3 §13): export the legacy Telegram role holders.
 *
 *   bun scripts/idp-migration-export.ts --out <file.json>
 *
 * Reads tg_permissions and tg_group_admins in a read-only transaction, using only the DB_*
 * variables. It does not import "@/db", which would run migrations. The output contains
 * Telegram IDs and usernames: keep it out of the repository and delete it after the migration.
 */
import { writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { SQL } from "bun"
import { z } from "zod"
import { EXPORT_SCHEMA, type LegacyExport, legacyExportSchema } from "./lib/legacy-access"

const { values } = parseArgs({ options: { out: { type: "string" } } })
if (!values.out) {
  console.error("Usage: bun scripts/idp-migration-export.ts --out <file.json>")
  process.exit(2)
}

const env = z
  .object({
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().min(1).max(65535).default(5432),
    DB_USER: z.string().min(1),
    DB_PASS: z.string().min(1),
    DB_NAME: z.string().min(3).default("polinetwork_backend"),
  })
  .parse(process.env)

const sql = new SQL({
  hostname: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASS,
  database: env.DB_NAME,
  max: 1,
})

const iso = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString())

try {
  const exported: LegacyExport = await sql.begin("read only", async (tx) => {
    const holders = await tx`
      SELECT p.user_id::text AS "telegramId", u.username, p.roles,
        p.added_by_id::text AS "addedBy", p.modified_by_id::text AS "modifiedBy",
        p.created_at AS "createdAt", p.updated_at AS "updatedAt"
      FROM tg_permissions p
      LEFT JOIN tg_users u ON u.user_id = p.user_id
      ORDER BY p.user_id`
    const groupAdmins = await tx`
      SELECT a.user_id::text AS "telegramId", u.username, a.group_id::text AS "groupId",
        g.title AS "groupTitle", a.added_by_id::text AS "addedBy", a.created_at AS "createdAt"
      FROM tg_group_admins a
      LEFT JOIN tg_users u ON u.user_id = a.user_id
      LEFT JOIN tg_groups g ON g.telegram_id = a.group_id
      ORDER BY a.user_id, a.group_id`
    return legacyExportSchema.parse({
      schema: EXPORT_SCHEMA,
      exportedAt: new Date().toISOString(),
      holders: holders.map((row: Record<string, unknown>) => ({
        ...row,
        createdAt: iso(row.createdAt as Date),
        updatedAt: iso(row.updatedAt as Date | null),
      })),
      groupAdmins: groupAdmins.map((row: Record<string, unknown>) => ({
        ...row,
        createdAt: iso(row.createdAt as Date),
      })),
    })
  })
  await writeFile(values.out, `${JSON.stringify(exported, null, 2)}\n`, { mode: 0o600, flag: "wx" })
  console.log(
    `Exported ${exported.holders.length} role holders and ${exported.groupAdmins.length} group-admin assignments to ${values.out}`
  )
} finally {
  await sql.close()
}
