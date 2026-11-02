import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "syncs two Yjs clients through the collab service, with tickets, read-only roles, ids, freeze and persistence",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/regulations-collab.fixture.ts"], {
      env: process.env,
      timeout: 90_000,
    })
    const result = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"checked"')) ?? "{}"
    )
    expect(result.checked).toHaveLength(10)
  },
  95_000
)
