import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

const exec = promisify(execFile)
const port = process.env.FRESHMAN_TEST_DB_PORT

describe.skipIf(!port)("Freshman PostgreSQL integration", () => {
  it("keeps the website/admin contract durable and consistent under concurrent changes", async () => {
    const { stdout } = await exec("bun", ["--no-env-file", "tests/fixtures/freshman-integration.ts"], {
      env: { PATH: process.env.PATH, FRESHMAN_TEST_DB_PORT: port },
      maxBuffer: 1024 * 1024,
    })
    expect(stdout).toContain("PASS: migration FAQ reuse")
  }, 30_000)
})
