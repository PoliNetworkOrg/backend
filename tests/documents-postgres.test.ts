import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "serves the website documents catalog and its admin from real PostgreSQL",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["--no-env-file", "tests/documents-postgres.fixture.ts"], {
      env: { PATH: process.env.PATH, SEED_TEST_DB_PORT: process.env.SEED_TEST_DB_PORT },
      timeout: 60000,
    })
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
    expect(result.checked).toHaveLength(9)
  },
  65000
)
