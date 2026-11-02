import type { DeliberaBody, Files } from "../contract"

/**
 * The delibera metadata in the entry file's preamble (legal `docs/grammar.md`):
 *
 *   \approvazione{direttivo|assemblea}{YYYY-MM-DD}      the last approval
 *   \rettifica[<delegato>]{YYYY-MM-DD}                   a later rectification (optional argument: on a delega)
 *
 * `\delibera` prints them in place of `\today`. Emanating an approval sets `\approvazione` and drops any
 * `\rettifica`; emanating a rettifica keeps the approval and sets `\rettifica`.
 */
export type DeliberaInput =
  | { kind: "approvazione"; body: DeliberaBody; date: string }
  | { kind: "rettifica"; date: string; delegate: string | null }

const ORGANO: Record<DeliberaBody, string> = { consiglio_direttivo: "direttivo", assemblea: "assemblea" }

const APPROVAZIONE = /^([^%\n]*?)\\approvazione\s*\{[^{}]*\}\s*\{[^{}]*\}[^\n]*\n?/m
const RETTIFICA = /^([^%\n]*?)\\rettifica\s*(\[[^\]]*\])?\s*\{[^{}]*\}[^\n]*\n?/m

/** Escapes text for a LaTeX argument (a delegate's name). */
export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_%~]/g, (c) =>
    c === "\\" ? "\\textbackslash{}" : c === "~" ? "\\textasciitilde{}" : c === "^" ? "\\textasciicircum{}" : `\\${c}`
  )
}

export class DeliberaMacroMissing extends Error {}

export function applyDelibera(files: Files, entry: string, delibera: DeliberaInput): Files {
  const text = files[entry]
  if (text === undefined || !APPROVAZIONE.test(text))
    throw new DeliberaMacroMissing(`Manca \\approvazione{…}{…} nel preambolo di ${entry}`)
  let out: string
  if (delibera.kind === "approvazione") {
    out = text.replace(
      APPROVAZIONE,
      (_, lead: string) => `${lead}\\approvazione{${ORGANO[delibera.body]}}{${delibera.date}}\n`
    )
    out = out.replace(RETTIFICA, (_, lead: string) => (lead.trim() ? lead : ""))
  } else {
    const macro = `\\rettifica${delibera.delegate ? `[${escapeLatex(delibera.delegate)}]` : ""}{${delibera.date}}`
    if (RETTIFICA.test(text)) out = text.replace(RETTIFICA, (_, lead: string) => `${lead}${macro}\n`)
    else out = text.replace(APPROVAZIONE, (line: string) => `${line.endsWith("\n") ? line : `${line}\n`}${macro}\n`)
  }
  return { ...files, [entry]: out }
}
