import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import {
  type AssetBundle,
  bundleHash,
  type CompileRequest,
  type CompileResponse,
  safeRelativePath,
} from "../compile/protocol"
import { createLatestWinsQueue } from "../compile/queue"
import { runXelatex } from "./xelatex"

/**
 * The LaTeX compile worker: a separate service and image (`FROM ghcr.io/polinetworkorg/legal-texlive`), never inside
 * the backend. It keeps a warm workdir per key so `.aux` files survive, runs at most one compile per key (latest
 * wins) and `WORKER_CONCURRENCY` overall, and has no database and no network egress.
 */

const config = {
  port: Number(process.env.WORKER_PORT ?? 4200),
  secret: process.env.WORKER_SECRET ?? "",
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
  timeoutMs: Number(process.env.WORKER_TIMEOUT_MS ?? 45_000),
  workDir: process.env.WORKER_WORK_DIR ?? "/work",
  tmpDir: process.env.WORKER_TMP_DIR ?? "/tmp",
  maxWorkdirs: Number(process.env.WORKER_MAX_WORKDIRS ?? 40),
  memoryLimitMb: process.env.WORKER_MEMORY_LIMIT_MB ? Number(process.env.WORKER_MEMORY_LIMIT_MB) : 1024,
  /** The class from the legal repository's `shared/`, linked next to the entry file. */
  sharedClass: "polinetwork-regolamento.cls",
}

const MAX_BODY = 64 * 1024 * 1024
/**
 * TeX Live doesn't apply `openin_any=p` to `\input` of absolute paths, so xelatex can read any file this user can.
 * Workdir names are keyed with a per-process secret, so one draft's LaTeX can't `\input` another draft's files.
 */
const WORKDIR_SALT = randomBytes(32)
const queue = createLatestWinsQueue<Response>(config.concurrency)
const lastUsed = new Map<string, number>()

function authorized(req: Request): boolean {
  if (!config.secret) return true
  const given = Buffer.from(req.headers.get("authorization") ?? "")
  const expected = Buffer.from(`Bearer ${config.secret}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const json = (body: unknown, status = 200) => Response.json(body, { status })
const assetsDir = (hash: string) => join(config.workDir, "assets", hash)
const workdirOf = (key: string) =>
  join(config.workDir, "w", createHmac("sha256", WORKDIR_SALT).update(key).digest("hex").slice(0, 32))

/**
 * Makes this process non-dumpable (Linux), so its `/proc/<pid>/environ` (with WORKER_SECRET) belongs to root and
 * xelatex, running as the same user, can't read it. xelatex itself gets a clean environment.
 */
async function hideEnvironment() {
  if (process.platform !== "linux") return
  try {
    const { dlopen } = await import("bun:ffi")
    const libc = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } })
    const PR_SET_DUMPABLE = 4
    if (libc.symbols.prctl(PR_SET_DUMPABLE, 0n, 0n, 0n, 0n) !== 0) throw new Error("prctl failed")
  } catch (error) {
    console.error(JSON.stringify({ msg: "could not make the worker non-dumpable", error: String(error) }))
  }
}

async function storeAssets(hash: string, bundle: AssetBundle): Promise<Response> {
  if (!/^[a-f0-9]{64}$/.test(hash)) return json({ error: "bad hash" }, 400)
  if ((await bundleHash(bundle)) !== hash) return json({ error: "hash mismatch" }, 400)
  if (existsSync(assetsDir(hash))) return json({ ok: true })
  const staging = `${assetsDir(hash)}.${process.pid}.${Date.now()}`
  for (const [path, base64] of Object.entries(bundle.files)) {
    if (!safeRelativePath(path)) return json({ error: `bad path ${path}` }, 400)
    const target = join(staging, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, Buffer.from(base64, "base64"))
  }
  await mkdir(staging, { recursive: true })
  await rename(staging, assetsDir(hash)).catch(async () => rm(staging, { recursive: true, force: true }))
  return json({ ok: true })
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...(await listFiles(join(dir, entry.name), rel)))
    else out.push(rel)
  }
  return out
}

/** Links the assets into the workdir (once per bundle) and writes the sources that changed. */
async function prepare(dir: string, request: CompileRequest) {
  await mkdir(dir, { recursive: true })
  const marker = join(dir, ".assets")
  const linked = await readFile(marker, "utf8").catch(() => null)
  if (linked !== request.assets) {
    const source = assetsDir(request.assets)
    for (const path of await listFiles(source)) {
      const target = join(dir, path.startsWith("shared/") ? path.slice("shared/".length) : path)
      await mkdir(dirname(target), { recursive: true })
      await rm(target, { force: true })
      await symlink(join(source, path), target)
    }
    await writeFile(marker, request.assets)
  }
  const listPath = join(dir, ".sources.json")
  const previous: string[] = JSON.parse(await readFile(listPath, "utf8").catch(() => "[]"))
  for (const path of previous) if (!(path in request.files)) await rm(join(dir, path), { force: true })
  for (const [path, content] of Object.entries(request.files)) {
    const target = join(dir, path)
    const current = await readFile(target, "utf8").catch(() => null)
    if (current === content) continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  await writeFile(listPath, JSON.stringify(Object.keys(request.files)))
}

async function evict() {
  if (lastUsed.size <= config.maxWorkdirs) return
  const oldest = [...lastUsed].sort((a, b) => a[1] - b[1]).slice(0, lastUsed.size - config.maxWorkdirs)
  for (const [key] of oldest) {
    if (queue.busy(key)) continue
    lastUsed.delete(key)
    await rm(workdirOf(key), { recursive: true, force: true })
  }
}

async function compile(request: CompileRequest): Promise<Response> {
  if (typeof request.key !== "string" || !request.key || request.key.length > 100)
    return json({ error: "bad key" }, 400)
  if (!safeRelativePath(request.entry) || !request.entry.endsWith(".tex")) return json({ error: "bad entry" }, 400)
  if (!request.files || typeof request.files !== "object") return json({ error: "bad files" }, 400)
  for (const [path, content] of Object.entries(request.files))
    if (!safeRelativePath(path) || typeof content !== "string") return json({ error: `bad path ${path}` }, 400)
  if (!/^[a-f0-9]{64}$/.test(request.assets)) return json({ error: "bad assets" }, 400)
  if (!existsSync(assetsDir(request.assets))) return json({ status: "assets_missing" } satisfies CompileResponse)

  const scheduled = await queue.schedule(request.key, async () => {
    const dir = workdirOf(request.key)
    lastUsed.set(request.key, Date.now())
    await prepare(dir, request)
    const result = await runXelatex(dir, request.entry, {
      timeoutMs: config.timeoutMs,
      tmpDir: config.tmpDir,
      memoryLimitMb: config.memoryLimitMb,
    })
    return json({ status: "done", ...result } satisfies CompileResponse)
  })
  void evict()
  return scheduled.status === "done" ? scheduled.value : json({ status: "superseded" } satisfies CompileResponse)
}

export function startWorker() {
  const server = Bun.serve({
    port: config.port,
    maxRequestBodySize: MAX_BODY,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health") return json({ ok: true, ...queue.stats() })
      if (!authorized(req)) return json({ error: "unauthorized" }, 401)
      try {
        if (req.method === "PUT" && url.pathname.startsWith("/assets/"))
          return await storeAssets(url.pathname.slice("/assets/".length), (await req.json()) as AssetBundle)
        if (req.method === "POST" && url.pathname === "/compile")
          return await compile((await req.json()) as CompileRequest)
        return json({ error: "not found" }, 404)
      } catch (error) {
        console.error(JSON.stringify({ msg: "worker request failed", error: String(error) }))
        return json({ error: "internal error" }, 500)
      }
    },
  })
  console.log(JSON.stringify({ msg: "latex worker listening", port: server.port, concurrency: config.concurrency }))
  return server
}

if (import.meta.main) {
  await hideEnvironment()
  await mkdir(join(config.workDir, "assets"), { recursive: true })
  await mkdir(join(config.workDir, "w"), { recursive: true })
  await stat(config.tmpDir)
  startWorker()
}
