import { isAsset } from "./compile/assets"

/**
 * New documents from a template of `documents.json`: the skeleton's files with `{{TITLE}}`, `{{KEY}}` and `{{DATE}}`
 * filled in, for a pull request on the repository or a private document.
 */

/** Where a new repository document goes: `regolamenti/<key>/` for the `regolamento` template, else `generali/<key>/`. */
export function placementOf(template: string): string {
  return template === "regolamento" ? "regolamenti" : "generali"
}

const LATEX_SPECIALS: Record<string, string> = {
  "\\": "\\textbackslash{}",
  "{": "\\{",
  "}": "\\}",
  $: "\\$",
  "&": "\\&",
  "%": "\\%",
  "#": "\\#",
  _: "\\_",
  "~": "\\textasciitilde{}",
  "^": "\\textasciicircum{}",
}

/** A title typed in the dashboard, safe inside LaTeX text. */
export function latexEscape(text: string): string {
  return text.replace(/[\\{}$&%#_~^]/g, (c) => LATEX_SPECIALS[c])
}

export class TemplateError extends Error {}

export type FilledSkeleton = {
  /** The main file (a top-level `.tex` with `\documentclass`). */
  entry: string
  /** The `.tex` files, placeholders filled: the editable sources. */
  sources: Record<string, string>
  /** documents.json `sources` globs covering them. */
  sourceGlobs: string[]
  /** What the compile needs besides the sources (images, included PDFs), as the repository's sync would read them. */
  assets: Record<string, Uint8Array>
  /** Every file to commit for a repository document (sources and the rest, `latexmkrc` included). */
  commit: Record<string, string | Uint8Array>
}

/**
 * Fills a skeleton: placeholders in `.tex` files (and `{{KEY}}` in file names), `{{TITLE}}` escaped for LaTeX, the date
 * as `YYYY-MM-DD`.
 */
export function fillSkeleton(
  skeleton: Record<string, Uint8Array>,
  values: { title: string; key: string; date: string }
): FilledSkeleton {
  const sources: Record<string, string> = {}
  const assets: Record<string, Uint8Array> = {}
  const commit: Record<string, string | Uint8Array> = {}
  for (const [rawPath, bytes] of Object.entries(skeleton)) {
    const path = rawPath.replaceAll("{{KEY}}", values.key)
    if (path.endsWith(".tex")) {
      const text = new TextDecoder()
        .decode(bytes)
        .replaceAll("{{TITLE}}", latexEscape(values.title))
        .replaceAll("{{KEY}}", values.key)
        .replaceAll("{{DATE}}", values.date)
      sources[path] = text
      commit[path] = text
      continue
    }
    commit[path] = bytes
    if (isAsset(path)) assets[path] = bytes
  }
  const mains = Object.keys(sources).filter((p) => !p.includes("/") && /\\documentclass\b/.test(sources[p]))
  const entry =
    mains.length === 1
      ? mains[0]
      : (mains.find((p) => p === `${values.key}.tex`) ?? mains.find((p) => p === "main.tex") ?? null)
  if (!entry)
    throw new TemplateError(
      mains.length
        ? `Il modello ha più file principali (${mains.join(", ")}): non so quale usare.`
        : "Il modello non ha un file principale (.tex con \\documentclass) nella sua cartella."
    )
  const dirs = new Set(Object.keys(sources).map((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "")))
  const sourceGlobs = [...dirs].sort().map((d) => (d ? `${d}/*.tex` : "*.tex"))
  return { entry, sources, sourceGlobs, assets, commit }
}
