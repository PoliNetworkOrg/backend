import { execFile, spawnSync } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { matchesGlob } from "@/regulations/compile/assets"
import { type CompileResponse, safeRelativePath, sourceHash } from "@/regulations/compile/protocol"
import { createLatestWinsQueue } from "@/regulations/compile/queue"
import { type CompileStore, createCompiler } from "@/regulations/compile/service"
import { parseLog } from "@/regulations/worker/xelatex"

const tick = () => new Promise((r) => setTimeout(r, 0))

describe("latest-wins queue", () => {
  it("runs one job per key, replaces a waiting job, and caps concurrency", async () => {
    const queue = createLatestWinsQueue<string>(2)
    const releases: (() => void)[] = []
    const started: string[] = []
    const job = (name: string) => () =>
      new Promise<string>((resolve) => {
        started.push(name)
        releases.push(() => resolve(name))
      })
    const a1 = queue.schedule("a", job("a1"))
    const a2 = queue.schedule("a", job("a2"))
    const a3 = queue.schedule("a", job("a3"))
    const b1 = queue.schedule("b", job("b1"))
    const c1 = queue.schedule("c", job("c1"))
    await tick()
    expect(started).toEqual(["a1", "b1"])
    expect(await a2).toEqual({ status: "superseded" })
    releases.shift()?.()
    expect(await a1).toEqual({ status: "done", value: "a1" })
    await tick()
    // a3 waited for a1; c1 waited for a free slot.
    expect(started).toEqual(["a1", "b1", "a3"])
    while (releases.length) releases.shift()?.()
    await tick()
    while (releases.length) releases.shift()?.()
    expect(await a3).toEqual({ status: "done", value: "a3" })
    expect(await b1).toEqual({ status: "done", value: "b1" })
    expect(await c1).toEqual({ status: "done", value: "c1" })
  })
})

describe("compile protocol", () => {
  it("hashes sources canonically and refuses paths that escape the workdir", async () => {
    const a = await sourceHash({ entry: "RRI.tex", assets: "x", files: { "a.tex": "1", "b.tex": "2" } })
    const b = await sourceHash({ entry: "RRI.tex", assets: "x", files: { "b.tex": "2", "a.tex": "1" } })
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
    expect(await sourceHash({ entry: "RRI.tex", assets: "y", files: { "a.tex": "1", "b.tex": "2" } })).not.toBe(a)
    for (const bad of ["/etc/passwd", "../x.tex", "a/../../x", ".latexmkrc", "a/.hidden", "a\\b", ""])
      expect(safeRelativePath(bad), bad).toBe(false)
    expect(safeRelativePath("regolamenti/1_fondamentale.tex")).toBe(true)
    expect(matchesGlob("regolamenti/2_interno.tex", "regolamenti/*.tex")).toBe(true)
    expect(matchesGlob("regolamenti/sub/x.tex", "regolamenti/*.tex")).toBe(false)
    expect(matchesGlob("regolamenti/sub/x.tex", "regolamenti/**.tex")).toBe(true)
  })

  it("reads errors with positions from a -file-line-error log", () => {
    const log = [
      "(./regolamenti/2_interno.tex",
      "./regolamenti/2_interno.tex:32: LaTeX Error: \\begin{commi} on input line 8 ended by \\end{comi}.",
      "",
      "l.32 \\end{comi}",
    ].join("\n")
    expect(parseLog(log)).toEqual([
      {
        file: "regolamenti/2_interno.tex",
        line: 32,
        message: "LaTeX Error: \\begin{commi} on input line 8 ended by \\end{comi}.",
      },
    ])
    expect(parseLog("! Emergency stop.\n")).toEqual([{ file: null, line: null, message: "Emergency stop." }])
  })
})

function memoryStore() {
  const compiles = new Map<string, { ok: boolean; errors: never[]; log: string }>()
  const statuses: { draftId: string; state: string; hash: string; goodHash?: string }[] = []
  const store: CompileStore = {
    findCompile: async (hash) => compiles.get(hash) ?? null,
    saveCompile: async (hash, r) => {
      compiles.set(hash, { ok: r.ok, errors: [], log: r.log })
    },
    addRef: async () => {},
    setDraftStatus: async (draftId, s) => {
      statuses.push({ draftId, state: s.state, hash: s.hash, goodHash: s.goodHash })
    },
  }
  return { store, compiles, statuses }
}

describe("compiler", () => {
  it("serves a cached hash without the worker and compiles only the latest text of a draft", async () => {
    const { store, statuses } = memoryStore()
    const calls: string[] = []
    let release: (() => void) | null = null
    const worker = {
      compile: async (req: { files: Record<string, string> }): Promise<CompileResponse> => {
        calls.push(req.files["main.tex"])
        if (calls.length === 1)
          await new Promise<void>((r) => {
            release = r
          })
        return { status: "done", ok: true, pdf: "JVBERg==", log: "", errors: [], durationMs: 1, runs: 1 }
      },
    }
    const events: string[] = []
    const compiler = createCompiler({ store, worker, onEvent: (e) => events.push(e.state) })
    const job = (text: string) => ({ draftId: "d1", entry: "main.tex", assets: "a", files: { "main.tex": text } })
    await compiler.request(job("v1"))
    await tick()
    await compiler.request(job("v2"))
    await compiler.request(job("v3"))
    await tick()
    ;(release as unknown as () => void)()
    for (let i = 0; i < 10; i++) await tick()
    // v2 was replaced by v3 while v1 compiled.
    expect(calls).toEqual(["v1", "v3"])
    const last = statuses[statuses.length - 1]
    expect(last.state).toBe("ok")
    // The same text again: cached, no new worker call.
    const v1hash = await compiler.request(job("v1"))
    expect(calls).toHaveLength(2)
    expect(statuses[statuses.length - 1]).toMatchObject({ state: "ok", hash: v1hash, goodHash: v1hash })
    expect(events).toContain("running")
  })

  it("reports an unreachable worker without caching it", async () => {
    const { store, statuses, compiles } = memoryStore()
    const worker = { compile: async (): Promise<CompileResponse> => Promise.reject(new Error("ECONNREFUSED")) }
    const compiler = createCompiler({ store, worker })
    await compiler.request({ draftId: "d1", entry: "main.tex", assets: "a", files: { "main.tex": "x" } })
    for (let i = 0; i < 5; i++) await tick()
    expect(statuses[statuses.length - 1].state).toBe("error")
    expect(compiles.size).toBe(0)
  })
})

const hasXelatex = spawnSync("xelatex", ["--version"]).status === 0
it.skipIf(!hasXelatex)(
  "the worker compiles with xelatex, uploads missing assets, reports errors and keeps writes in the workdir",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/regulations-worker.fixture.ts"], {
      env: process.env,
      timeout: 90_000,
    })
    const result = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"checked"')) ?? "{}"
    )
    expect(result.checked).toHaveLength(5)
  },
  95_000
)
