import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { expect, it } from "vitest"

it("drives the GitHub App client against an imitation of the GitHub API: commit, PR, auto-merge, tag, release assets", async () => {
  const { stdout } = await promisify(execFile)("bun", ["tests/regulations-github.fixture.ts"], {
    env: process.env,
    timeout: 90_000,
  })
  const result = JSON.parse(
    stdout
      .trim()
      .split("\n")
      .findLast((line) => line.startsWith('{"checked"')) ?? "{}"
  )
  expect(result.checked).toHaveLength(3)
}, 95_000)
