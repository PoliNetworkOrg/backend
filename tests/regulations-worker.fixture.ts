import assert from "node:assert/strict"
import { existsSync, mkdtempSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorkerClient } from "@/regulations/compile/client"
import { type AssetBundle, bundleHash, sourceHash } from "@/regulations/compile/protocol"

const dir = mkdtempSync(join(tmpdir(), "regs-worker-"))
process.env.WORKER_WORK_DIR = join(dir, "work")
process.env.WORKER_TMP_DIR = dir
process.env.WORKER_PORT = "0"
process.env.WORKER_SECRET = "s3cret"
await mkdir(join(dir, "work/assets"), { recursive: true })
const { startWorker } = await import("@/regulations/worker/server")
const server = startWorker()
const checked: string[] = []
try {
  const assets: AssetBundle = {
    version: 1,
    files: { "shared/esempio.sty": Buffer.from("\\newcommand\\esempio{Esempio}\n").toString("base64") },
  }
  const assetsHash = await bundleHash(assets)
  let uploads = 0
  const client = createWorkerClient({
    url: `http://127.0.0.1:${server.port}`,
    secret: "s3cret",
    loadAssets: async () => {
      uploads++
      return assets
    },
  })
  const doc = (body: string) => ({
    "main.tex": `\\documentclass{article}\\usepackage{esempio}\\begin{document}\\esempio{} ${body}\\end{document}\n`,
  })
  const compile = async (files: Record<string, string>) =>
    client.compile({
      key: "d1",
      hash: await sourceHash({ entry: "main.tex", files, assets: assetsHash }),
      entry: "main.tex",
      assets: assetsHash,
      files,
    })
  const ok = await compile(doc("ciao"))
  assert.equal(ok.status === "done" && ok.ok, true)
  assert.equal(
    Buffer.from(ok.status === "done" ? (ok.pdf ?? "") : "", "base64")
      .subarray(0, 4)
      .toString(),
    "%PDF"
  )
  assert.equal(uploads, 1)
  checked.push("compiles a PDF with the shared class linked next to the entry, after uploading the assets")

  const broken = await compile(doc("\\begin{commi}"))
  assert.equal(broken.status === "done" && broken.ok, false)
  assert.equal(broken.status === "done" ? broken.errors[0]?.file : null, "main.tex")
  checked.push("reports a LaTeX error with its file")

  const outside = await compile(doc("\\immediate\\openout1=/tmp/regs-escape.txt\\immediate\\write1{x}"))
  assert.equal(outside.status === "done" && outside.ok, false)
  assert.equal(existsSync("/tmp/regs-escape.txt"), false)
  checked.push("refuses writes outside the workdir (openout_any=p)")

  const shell = await compile(doc(`\\immediate\\write18{touch ${dir}/pwned}`))
  assert.equal(shell.status, "done")
  assert.equal(existsSync(join(dir, "pwned")), false)
  checked.push("runs no shell commands (-no-shell-escape)")

  const unauthorized = await fetch(`http://127.0.0.1:${server.port}/compile`, { method: "POST", body: "{}" })
  assert.equal(unauthorized.status, 401)
  checked.push("refuses requests without the shared secret")
  console.log(JSON.stringify({ checked }))
} finally {
  server.stop(true)
}
