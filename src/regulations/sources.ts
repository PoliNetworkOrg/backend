import { matchesGlob } from "./compile/assets"
import type { Files, ValidationIssue } from "./contract"

/**
 * Source files a draft may hold: the paths matching the document's `sources` globs (documents.json). A file outside
 * them would be committed once and then never replaced, removed or read back by an import, so a draft can't be
 * approved or published with one.
 */
export function strayFiles(files: Files, globs: string[]): string[] {
  if (!globs.length) return []
  return Object.keys(files)
    .filter((path) => !globs.some((glob) => matchesGlob(path, glob)))
    .sort()
}

export function strayFilesMessage(stray: string[], globs: string[]) {
  const names = stray.map((path) => `«${path}»`).join(", ")
  const allowed = globs.map((glob) => `«${glob}»`).join(", ")
  return stray.length === 1
    ? `Il file ${names} non è tra i sorgenti del documento (${allowed}): rinominalo o eliminalo.`
    : `I file ${names} non sono tra i sorgenti del documento (${allowed}): rinominali o eliminali.`
}

/** The same check as editor problems, at the start of each stray file. */
export function strayIssues(files: Files, globs: string[]): ValidationIssue[] {
  return strayFiles(files, globs).map((file) => ({
    file,
    line: 1,
    column: 1,
    offset: 0,
    endOffset: 0,
    severity: "error",
    code: "stray_file",
    message: strayFilesMessage([file], globs),
  }))
}
