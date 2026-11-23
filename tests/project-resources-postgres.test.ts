import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "appends resources after deletions and only reorders when every target belongs to the project",
  async () => {
    await promisify(execFile)("bun", ["--no-env-file", "tests/fixtures/project-resources-postgres.ts"], {
      env: { PATH: process.env.PATH, SEED_TEST_DB_PORT: process.env.SEED_TEST_DB_PORT },
      timeout: 30000,
    })
  },
  35000
)
