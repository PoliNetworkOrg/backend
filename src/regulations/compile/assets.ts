import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { AssetBundle } from "./protocol"

/** Build products and outputs: never part of the assets. */
const BUILD_ARTIFACT = /\.(aux|log|out|toc|fls|fdb_latexmk|xdv|synctex\.gz|bbl|blg|lof|lot)$/

/** Whether `path` matches a documents.json source glob (`*` within one path segment, `**` across segments). */
export function matchesGlob(path: string, glob: string): boolean {
  const pattern = glob
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
    )
    .join(".*")
  return new RegExp(`^${pattern}$`).test(path)
}

export type DocumentLayout = {
  /** Directory of the document, relative to the repository root (documents.json `dir`). */
  dir: string
  entry: string
  sources: string[]
  /** Release asset names: built outputs to leave out. */
  outputs: Record<string, string>
  /** The template's `shared` directory (class, styles, fonts, images), or `null` for a self-contained document. */
  shared: string | null
}

/** Reads a repository: a checkout or GitHub. Paths are relative to the repository root. */
export type RepoReader = { list: (dir: string) => Promise<string[]>; read: (path: string) => Promise<Uint8Array> }

/** Files under `root`, relative to it, skipping dot files and dot directories. */
export async function listTree(root: string): Promise<string[]> {
  const out: string[] = []
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await visit(full)
      else out.push(relative(root, full).split("\\").join("/"))
    }
  }
  await visit(root)
  return out.sort()
}

/**
 * Splits a document directory of a documents checkout into editable sources (matching `sources`) and the asset bundle
 * the compile needs: everything else in the directory (fonts, images, included PDFs) plus the template's whole shared
 * tree, which goes under `shared/` (the worker puts it next to the entry file, on TEXINPUTS, TTFONTS and OPENTYPEFONTS).
 */
export async function readDocument(
  repoRoot: string,
  layout: DocumentLayout
): Promise<{ sources: Record<string, string>; assets: AssetBundle }> {
  return readDocumentWith(
    {
      list: (dir) => listTree(join(repoRoot, dir)),
      read: async (path) => new Uint8Array(await readFile(join(repoRoot, path))),
    },
    layout
  )
}

/**
 * Files read at once. Over GitHub every file is a request: one after the other, a sync of the whole repository took
 * longer than the server's idle timeout.
 */
const READ_CONCURRENCY = 8

/** `fn` over `items`, at most `limit` at a time, with the results in the items' order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const run = async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run))
  return results
}

/** The same split over any repository reader (a checkout, or GitHub). */
export async function readDocumentWith(
  repo: RepoReader,
  layout: DocumentLayout
): Promise<{ sources: Record<string, string>; assets: AssetBundle }> {
  const outputs = new Set([...Object.values(layout.outputs), layout.entry.replace(/\.tex$/, ".pdf")])
  const paths = (await repo.list(layout.dir)).flatMap((path) => {
    if (layout.sources.some((glob) => matchesGlob(path, glob))) return [{ path, source: true }]
    if (!isAsset(path) || outputs.has(path) || path.endsWith(".tex")) return []
    return [{ path, source: false }]
  })
  const read = await mapLimit(paths, READ_CONCURRENCY, ({ path }) => repo.read(`${layout.dir}/${path}`))
  const sources: Record<string, string> = {}
  const files: Record<string, string> = {}
  paths.forEach(({ path, source }, i) => {
    const bytes = read[i]
    if (source) sources[path] = new TextDecoder().decode(bytes)
    else files[path] = Buffer.from(bytes).toString("base64")
  })
  if (layout.shared) Object.assign(files, sharedAssets(await readTreeWith(repo, layout.shared)))
  return { sources, assets: { version: 1, files } }
}

/** Every file under `dir` that `keep` accepts (by default: no dot files, build products, latexmkrc), relative to it. */
export async function readTreeWith(
  repo: RepoReader,
  dir: string,
  keep: (path: string) => boolean = isAsset
): Promise<Record<string, Uint8Array>> {
  const paths = (await repo.list(dir)).filter(keep)
  const read = await mapLimit(paths, READ_CONCURRENCY, (path) => repo.read(`${dir}/${path}`))
  return Object.fromEntries(paths.map((path, i) => [path, read[i]]))
}

/** Not a dot file or inside a dot directory. */
export const notHidden = (path: string) => !path.split("/").some((part) => part.startsWith("."))

/** A template's shared tree as bundle entries under `shared/`, in base64. */
export function sharedAssets(shared: Record<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(shared).map(([path, bytes]) => [`shared/${path}`, Buffer.from(bytes).toString("base64")])
  )
}

/** Not a build product, a latexmk configuration, or a dot file. */
export function isAsset(path: string): boolean {
  const name = path.split("/").pop() ?? path
  return !BUILD_ARTIFACT.test(path) && name !== "latexmkrc" && notHidden(path)
}
