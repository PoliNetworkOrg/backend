import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { courseFileSchema, coursesMigrationSql } from "../../src/polimi/manifesti"

/**
 * Writes the data migration for a reviewed course file into an empty custom migration (see README.md):
 *
 *   bun scripts/polimi-courses/sql.ts scripts/polimi-courses/data/2026-27.json drizzle/00xx_polimi_courses_2026_27.sql
 */

const { positionals } = parseArgs({ allowPositionals: true })
const [input, output] = positionals
if (!input || !output || positionals.length !== 2) {
  console.error("Usage: bun scripts/polimi-courses/sql.ts <course file> <empty custom migration>")
  process.exit(2)
}
const existing = await readFile(output, "utf8")
if (existing.replace(/--.*$/gm, "").trim()) {
  console.error(`${output} isn't empty: create a new one with drizzle-kit generate --custom`)
  process.exit(1)
}
const file = courseFileSchema.parse(JSON.parse(await readFile(input, "utf8")))
await writeFile(output, coursesMigrationSql(file))
console.log(`Wrote ${file.courses.length} courses for ${file.academicYear}/${file.academicYear + 1} to ${output}`)
