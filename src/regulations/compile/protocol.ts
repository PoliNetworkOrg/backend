/**
 * Wire protocol between the compile callers (collab service, backend) and the LaTeX worker. The worker has no network
 * egress and no database: everything it needs comes in the request, and the assets (fonts, the shared class) are
 * uploaded once per bundle hash and cached.
 */

/** Paths relative to the document directory (legal.json `dir`). */
export type CompileRequest = {
  /** Warm workdir key: the draft id (`.aux` survives between compiles), or `version:<id>`. */
  key: string
  /** Source hash (see `sourceHash`), echoed back. */
  hash: string
  entry: string
  /** Hash of the asset bundle the sources compile with. */
  assets: string
  files: Record<string, string>
}

export type CompileError = { file: string | null; line: number | null; message: string }

export type CompileResult = {
  ok: boolean
  /** Base64 PDF when `ok`. */
  pdf: string | null
  /** Tail of the xelatex log. */
  log: string
  errors: CompileError[]
  durationMs: number
  runs: number
}

export type CompileResponse =
  | ({ status: "done" } & CompileResult)
  /** A newer request for the same key arrived while this one waited: latest wins. */
  | { status: "superseded" }
  /** Upload the bundle with `PUT /assets/<hash>`, then retry. */
  | { status: "assets_missing" }

/** Non-editable files the compile needs, by path relative to the document directory; content in base64. */
export type AssetBundle = { version: 1; files: Record<string, string> }

export const WORKER_SECRET_HEADER = "authorization"

async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)
  return Buffer.from(digest).toString("hex")
}

function canonical(record: Record<string, string>): string {
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((k) => [k, record[k]])
  )
}

/** Identifies a compile: same document, entry, sources and assets give the same PDF. */
export function sourceHash(input: { entry: string; files: Record<string, string>; assets: string }): Promise<string> {
  return sha256Hex(`v1\n${input.entry}\n${input.assets}\n${canonical(input.files)}`)
}

export function bundleHash(bundle: AssetBundle): Promise<string> {
  return sha256Hex(`v1\n${canonical(bundle.files)}`)
}

/** Rejects absolute paths, `..` and anything that could escape the workdir or hide as a dot file. */
export function safeRelativePath(path: string): boolean {
  if (!path || path.length > 300 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) return false
  return path.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.startsWith("."))
}
