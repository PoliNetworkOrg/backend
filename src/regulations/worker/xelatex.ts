import { existsSync } from "node:fs"
import { readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import type { CompileError, CompileResult } from "../compile/protocol"

export type XelatexOptions = {
  /** Total time for every pass. */
  timeoutMs: number
  /** Scratch directory for TeX's caches (TEXMFVAR, HOME): the root filesystem is read-only. */
  tmpDir: string
  /** Address-space limit per process, through `prlimit` when available (Linux). */
  memoryLimitMb?: number
  maxRuns?: number
  binary?: string
}

const RERUN = /Rerun to get|Label\(s\) may have changed|Please rerun LaTeX|rerunfilecheck Warning/
const LOG_TAIL = 20_000

/** Errors from a `-file-line-error` log: `./regolamenti/x.tex:12: message`, or `! message` without a position. */
export function parseLog(log: string): CompileError[] {
  const errors: CompileError[] = []
  const lines = log.split("\n")
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const m = /^(.+?\.(?:tex|cls|sty)):(\d+): (.*)$/.exec(line)
    if (m) {
      const file = m[1].replace(/^\.\//, "")
      // The context line after "l.12 …" helps; keep the message short.
      errors.push({ file: file.startsWith("/") ? null : file, line: Number(m[2]), message: m[3].trim() })
    } else if (line.startsWith("! ") && !errors.length) {
      errors.push({ file: null, line: null, message: line.slice(2).trim() })
    }
  }
  if (!errors.length) {
    const fatal = lines.find((l) => /^!|Fatal error|Emergency stop/.test(l))
    if (fatal) errors.push({ file: null, line: null, message: fatal.replace(/^!\s*/, "") })
  }
  return errors.slice(0, 50)
}

/**
 * Runs xelatex in `dir` as many times as the log asks (at most `maxRuns`), sandboxed: no shell escape, files opened
 * and written only inside the working directory (`openin_any`/`openout_any` paranoid), a total timeout, a memory
 * limit. The container adds a non-root user, a read-only root, no network and CPU/memory limits.
 */
export async function runXelatex(dir: string, entry: string, options: XelatexOptions): Promise<CompileResult> {
  const started = Date.now()
  const jobname = entry.replace(/\.tex$/, "")
  const pdfPath = join(dir, `${jobname}.pdf`)
  await rm(pdfPath, { force: true })
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options.tmpDir,
    TEXMFVAR: join(options.tmpDir, "texmf-var"),
    TEXMFCONFIG: join(options.tmpDir, "texmf-config"),
    XDG_CACHE_HOME: join(options.tmpDir, "cache"),
    openin_any: "p",
    openout_any: "p",
    shell_escape: "f",
    max_print_line: "10000",
    // The class sits next to the entry file; nothing outside the workdir is searched but TeX Live itself.
    TEXINPUTS: ".:",
  }
  const args = [
    options.binary ?? "xelatex",
    "-no-shell-escape",
    "-interaction=nonstopmode",
    "-halt-on-error",
    "-file-line-error",
    entry,
  ]
  const cmd =
    options.memoryLimitMb && existsSync("/usr/bin/prlimit")
      ? ["/usr/bin/prlimit", `--as=${options.memoryLimitMb * 1024 * 1024}`, "--nproc=64", "--", ...args]
      : args

  let runs = 0
  let log = ""
  let exitOk = false
  const maxRuns = options.maxRuns ?? 3
  while (runs < maxRuns) {
    const remaining = options.timeoutMs - (Date.now() - started)
    if (remaining <= 0) {
      return result(false, null, `${log}\n! Compile timed out`, [{ file: null, line: null, message: "Tempo scaduto" }])
    }
    runs++
    const proc = Bun.spawn(cmd, {
      cwd: dir,
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: remaining,
      killSignal: "SIGKILL",
    })
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
    const code = await proc.exited
    log = (await readFile(join(dir, `${jobname}.log`), "utf8").catch(() => stdout)) || stdout
    if (proc.signalCode === "SIGKILL")
      return result(false, null, `${log}\n! Compile timed out`, [{ file: null, line: null, message: "Tempo scaduto" }])
    exitOk = code === 0
    if (!exitOk || !RERUN.test(log)) break
  }

  function result(ok: boolean, pdf: string | null, text: string, errors: CompileError[]): CompileResult {
    return { ok, pdf, log: text.slice(-LOG_TAIL), errors, durationMs: Date.now() - started, runs }
  }

  const pdf = exitOk && existsSync(pdfPath) ? await readFile(pdfPath) : null
  if (!pdf) {
    const errors = parseLog(log)
    return result(
      false,
      null,
      log,
      errors.length ? errors : [{ file: null, line: null, message: "Compilazione fallita" }]
    )
  }
  return result(true, Buffer.from(pdf).toString("base64"), log, [])
}
