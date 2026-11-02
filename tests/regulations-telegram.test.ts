import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("runs tests/regulations-telegram.fixture.ts with Bun", async () => {
  const { stdout } = await promisify(execFile)("bun", ["tests/regulations-telegram.fixture.ts"], {
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
}, 65_000)
