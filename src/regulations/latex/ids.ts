import type { Files } from "../contract"
import { type ParsedDocument, parseDocument, walk } from "./document"
import { ID_PATTERN } from "./parse"

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz"

/** A new id (lowercase base36, 6 chars) not in `taken`. */
export function generateId(taken: ReadonlySet<string>, random: () => number = cryptoRandom): string {
  for (;;) {
    let id = ""
    for (let i = 0; i < 6; i++) id += ALPHABET[Math.floor(random() * 36)]
    if (!taken.has(id)) return id
  }
}

function cryptoRandom(): number {
  const buf = new Uint32Array(1)
  crypto.getRandomValues(buf)
  return buf[0] / 2 ** 32
}

/** A text edit: replace `[start, end)` in `file` with `insert`. */
export type TextEdit = { file: string; start: number; end: number; insert: string }

/**
 * Edits that give every regolamento, capo, articolo and comma a valid unique id: missing ids are inserted right
 * after the command (`\articolo[id=k3x9a2]{…}`), invalid or duplicate ones (the later occurrence) are replaced.
 * Ids are the system's: people never type them. Edits are sorted from the end of each file, so applying them in order
 * keeps the offsets valid.
 */
export function idEdits(doc: ParsedDocument, random?: () => number): TextEdit[] {
  const taken = new Set<string>()
  for (const p of doc.files.values())
    for (const node of walkParsed(p.root)) if (node.id && ID_PATTERN.test(node.id)) taken.add(node.id)
  const edits: TextEdit[] = []
  const used = new Set<string>()
  const files = [...doc.order, ...[...doc.files.keys()].filter((f) => !doc.order.includes(f))]
  for (const file of files) {
    const p = doc.files.get(file)
    if (!p) continue
    for (const node of walkParsed(p.root)) {
      if (node.kind === "file" || node.kind === "lettera") continue
      const valid = node.id !== null && ID_PATTERN.test(node.id) && !used.has(node.id)
      if (valid && node.id) {
        used.add(node.id)
        continue
      }
      const id = generateId(new Set([...taken, ...used]), random)
      used.add(id)
      if (node.idRange) edits.push({ file, start: node.idRange.start, end: node.idRange.end, insert: id })
      else if (node.optRange) {
        const inner = p.text.slice(node.optRange.start + 1, node.optRange.end - 1)
        edits.push({
          file,
          start: node.optRange.start + 1,
          end: node.optRange.start + 1,
          insert: inner.trim() ? `id=${id},` : `id=${id}`,
        })
      } else edits.push({ file, start: node.macroEnd, end: node.macroEnd, insert: `[id=${id}]` })
    }
  }
  return edits.sort((a, b) => (a.file === b.file ? b.start - a.start : a.file.localeCompare(b.file)))
}

export function applyEdits(files: Files, edits: TextEdit[]): Files {
  const out = { ...files }
  const byFile = new Map<string, TextEdit[]>()
  for (const e of edits) byFile.set(e.file, [...(byFile.get(e.file) ?? []), e])
  for (const [file, list] of byFile) {
    let text = out[file] ?? ""
    for (const e of [...list].sort((a, b) => b.start - a.start))
      text = text.slice(0, e.start) + e.insert + text.slice(e.end)
    out[file] = text
  }
  return out
}

/** The files with every structure id assigned and unique. */
export function ensureIds(files: Files, entry: string, random?: () => number): { files: Files; edits: TextEdit[] } {
  const edits = idEdits(parseDocument(files, entry), random)
  return { files: edits.length ? applyEdits(files, edits) : files, edits }
}

function* walkParsed(node: import("./parse").ParsedNode): Generator<import("./parse").ParsedNode> {
  yield node
  for (const child of node.children) yield* walkParsed(child)
}

export { walk }
