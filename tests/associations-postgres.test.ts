import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "persists publication and serializes concurrent association approvals in PostgreSQL",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/associations-postgres.fixture.ts"], {
      env: process.env,
      timeout: 60000,
    })
    expect(JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}").checked).toHaveLength(8)
  },
  65000
)
