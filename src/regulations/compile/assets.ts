import { readdir, readFile } from "node:fs/promises"
import { join, relative } from "node:path"
import type { AssetBundle } from "./protocol"

/** Build products and outputs: never part of the assets. */
const BUILD_ARTIFACT = /\.(aux|log|out|toc|fls|fdb_latexmk|xdv|synctex\.gz|bbl|blg|lof|lot)$/

/** Whether `path` matches a legal.json source glob (`*` within one path segment, `**` across segments). */
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
  /** Directory of the document, relative to the repository root (legal.json `dir`). */
  dir: string
  entry: string
  sources: string[]
  /** Release asset names: built outputs to leave out. */
  outputs: Record<string, string>
  /** legal.json `shared`: the class directory. */
  shared: string
}

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
 * Splits a document directory of a legal checkout into editable sources (matching `sources`) and the asset bundle the
 * compile needs: everything else in the directory (fonts, images, included PDFs) plus the shared class, which goes
 * under `shared/` and is linked next to the entry file by the worker.
 */
export async function readDocument(
  repoRoot: string,
  layout: DocumentLayout
): Promise<{ sources: Record<string, string>; assets: AssetBundle }> {
  const docRoot = join(repoRoot, layout.dir)
  const outputs = new Set([...Object.values(layout.outputs), layout.entry.replace(/\.tex$/, ".pdf")])
  const sources: Record<string, string> = {}
  const files: Record<string, string> = {}
  for (const path of await listTree(docRoot)) {
    if (layout.sources.some((glob) => matchesGlob(path, glob))) {
      sources[path] = await readFile(join(docRoot, path), "utf8")
      continue
    }
    if (BUILD_ARTIFACT.test(path) || outputs.has(path) || path.endsWith(".tex") || path === "latexmkrc") continue
    files[path] = (await readFile(join(docRoot, path))).toString("base64")
  }
  for (const path of await listTree(join(repoRoot, layout.shared))) {
    if (!path.endsWith(".cls") && !path.endsWith(".sty")) continue
    if (path.includes("/")) continue
    files[`shared/${path}`] = (await readFile(join(repoRoot, layout.shared, path))).toString("base64")
  }
  return { sources, assets: { version: 1, files } }
}
