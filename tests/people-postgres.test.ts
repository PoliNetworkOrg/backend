import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "persists People records, identities and the mail outbox in real PostgreSQL",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/people-postgres.fixture.ts"], {
      env: process.env,
      timeout: 60000,
    })
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
    expect(result.checked).toHaveLength(4)
  },
  65000
)
