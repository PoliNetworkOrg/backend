import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "runs the regulations procedure against PostgreSQL: access, assignments, comments, merge, history, approval, deleghe",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/regulations-service.fixture.ts"], {
      env: process.env,
      timeout: 90_000,
    })
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}")
    expect(result.checked).toHaveLength(10)
  },
  95_000
)
