import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "runs tests/public-webhook.fixture.ts with Bun",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/public-webhook.fixture.ts"], {
      env: process.env,
      timeout: 60_000,
    })
    const result = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"checked"')) ?? "{}"
    )
    expect(result.checked).toHaveLength(2)
  },
  65_000
)
