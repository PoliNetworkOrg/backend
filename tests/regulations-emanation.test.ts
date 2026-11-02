import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "emanates through a fake GitHub: PR, auto-merge, tag, release, email and Telegram, resumable, with rettifiche on a delega",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/regulations-emanation.fixture.ts"], {
      env: process.env,
      timeout: 90_000,
    })
    const result = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"checked"')) ?? "{}"
    )
    expect(result.checked).toHaveLength(4)
  },
  95_000
)
