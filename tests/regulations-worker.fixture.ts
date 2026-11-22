import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
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
  checked.push("compiles a PDF with the shared files under shared/ next to the entry, after uploading the assets")

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

  // A template's whole shared tree: a package two directories down and a font loaded by file name only, both found
  // through TEXINPUTS / OPENTYPEFONTS (./shared//). The font is renamed, so nothing but the shared tree has it.
  const fontPath = spawnSync("kpsewhich", ["lmroman10-regular.otf"]).stdout.toString().trim()
  const tree: AssetBundle = {
    version: 1,
    files: {
      "shared/stili/annidati/profondo.sty": Buffer.from("\\newcommand\\profondo{Profondo}\n").toString("base64"),
      "shared/fonts/TestoProva-Regular.otf": readFileSync(fontPath).toString("base64"),
    },
  }
  const treeHash = await bundleHash(tree)
  const treeClient = createWorkerClient({
    url: `http://127.0.0.1:${server.port}`,
    secret: "s3cret",
    loadAssets: async () => tree,
  })
  const deep = {
    "main.tex":
      "\\documentclass{article}\\usepackage{fontspec}\\setmainfont{TestoProva-Regular.otf}\\usepackage{profondo}" +
      "\\begin{document}\\profondo{} ciao\\end{document}\n",
  }
  const nested = await treeClient.compile({
    key: "d2",
    hash: await sourceHash({ entry: "main.tex", files: deep, assets: treeHash }),
    entry: "main.tex",
    assets: treeHash,
    files: deep,
  })
  assert.equal(nested.status === "done" && nested.ok, true, nested.status === "done" ? nested.log.slice(-2000) : "")
  assert.match(nested.status === "done" ? nested.log : "", /TestoProva-Regular\.otf/)
  checked.push("finds packages and fonts anywhere in the shared tree (TEXINPUTS, OPENTYPEFONTS)")

  // The same workdir with another bundle: the old bundle's files are gone, so a dropped file can't linger.
  const stale = await treeClient.compile({
    key: "d2",
    hash: await sourceHash({ entry: "main.tex", files: deep, assets: assetsHash }),
    entry: "main.tex",
    assets: assetsHash,
    files: deep,
  })
  assert.equal(stale.status === "done" && stale.ok, false)
  checked.push("relinking a workdir to another bundle removes the previous bundle's files")

  const unauthorized = await fetch(`http://127.0.0.1:${server.port}/compile`, { method: "POST", body: "{}" })
  assert.equal(unauthorized.status, 401)
  checked.push("refuses requests without the shared secret")
  console.log(JSON.stringify({ checked }))
} finally {
  server.stop(true)
}
