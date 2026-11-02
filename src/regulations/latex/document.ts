import type { Files, StructureNode, ValidationIssue } from "../contract"
import { type FileContext, type FileParse, type ParsedNode, parseFile } from "./parse"

export type DocumentNode = Omit<StructureNode, "children"> & {
  /** Parent node id; the root has none. */
  parent: string | null
  /** The parsed node, for its text offsets. */
  parsed: ParsedNode
  children: DocumentNode[]
}

export type ParsedDocument = {
  /** No `error` issues. */
  parses: boolean
  tree: DocumentNode
  issues: ValidationIssue[]
  files: Map<string, FileParse>
  /** Files in document order (entry first, then `\input`s depth-first). */
  order: string[]
  /** Every structure node with an id, by id (the first one when duplicated). */
  nodes: Map<string, DocumentNode>
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz"
export const letterOf = (n: number) =>
  n <= 26 ? LETTERS[n - 1] : LETTERS[Math.floor((n - 1) / 26) - 1] + LETTERS[(n - 1) % 26]

const KIND_LABEL = {
  regolamento: "Regolamento",
  capo: "Capo",
  articolo: "Articolo",
  comma: "comma",
  lettera: "lettera",
}

/** Strips LaTeX commands from a title for labels: `\textbf{X}` → `X`. */
export function plainTitle(title: string | null): string | null {
  if (title === null) return null
  return title
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, "")
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\\(.)/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Parses every source file and joins them into one structure tree, following `\input` from the entry file.
 * Numbers are recomputed from order: regolamenti 1…n; capi and articles directly in a regolamento share the second
 * level (as `\subsection` does today); articles in a capo are the third level; commi and lettere count within their
 * parent.
 */
export function parseDocument(files: Files, entry: string): ParsedDocument {
  const parses = new Map<string, FileParse>()
  const issues: ValidationIssue[] = []
  const order: string[] = []
  /** Where each file is included (its first `\input`), so its nodes join the tree there. */
  const includedAt = new Map<string, FileParse["inputs"][number]>()
  const issueAt = (
    file: string,
    offset: number,
    code: string,
    message: string,
    severity: "error" | "warning",
    end = offset + 1
  ) => {
    const text = files[file] ?? ""
    const before = text.slice(0, offset)
    issues.push({
      file,
      line: before.split("\n").length,
      column: offset - before.lastIndexOf("\n"),
      offset,
      endOffset: end,
      severity,
      code,
      message,
    })
  }

  const visit = (path: string, context: FileContext) => {
    const text = files[path]
    if (text === undefined || parses.has(path)) return
    const parsed = parseFile(path, text, context)
    parses.set(path, parsed)
    order.push(path)
    issues.push(...parsed.issues)
    for (const input of parsed.inputs) {
      if (files[input.path] === undefined) {
        issueAt(
          path,
          input.offset,
          "missing_input",
          `File incluso non trovato tra i sorgenti: ${input.path}`,
          "warning"
        )
        continue
      }
      if (parses.has(input.path)) {
        issueAt(
          path,
          input.offset,
          "repeated_input",
          `${input.path} è già incluso altrove: la sua struttura conta una volta sola`,
          "warning"
        )
        continue
      }
      const kind = input.parent === parsed.root ? context : input.parent.kind
      if (kind !== "document" && kind !== "regolamento" && kind !== "capo") {
        issueAt(path, input.offset, "misplaced_input", "Non si può includere un file dentro un articolo", "error")
        continue
      }
      includedAt.set(input.path, input)
      visit(input.path, kind)
    }
  }
  if (files[entry] !== undefined) visit(entry, "document")
  else issueAt(entry, 0, "missing_entry", `File principale ${entry} mancante`, "error")

  for (const [path, text] of Object.entries(files)) {
    if (parses.has(path)) continue
    const parsed = parseFile(path, text)
    parses.set(path, parsed)
    issues.push(...parsed.issues)
    if (parsed.root.children.length)
      issueAt(
        path,
        parsed.root.children[0].start,
        "not_included",
        "Questo file non è incluso dal file principale: la sua struttura è ignorata",
        "warning"
      )
  }

  /** A node's children in document order, with the top-level nodes of the files it includes spliced in. */
  const childrenOf = (parsed: ParsedNode, file: string): { parsed: ParsedNode; file: string }[] => {
    const fp = parses.get(file)
    const out = parsed.children.map((child) => ({ parsed: child, file }))
    if (!fp) return out
    const inputs = fp.inputs.filter((input) => input.parent === parsed && includedAt.get(input.path) === input)
    for (const input of inputs) {
      const included = parses.get(input.path)
      if (!included) continue
      const at = out.findIndex((c) => c.file === file && c.parsed.start > input.offset)
      out.splice(at < 0 ? out.length : at, 0, ...childrenOf(included.root, input.path))
    }
    return out
  }

  const entryParse = parses.get(entry)
  const emptyRoot: ParsedNode = {
    kind: "file",
    id: null,
    idRange: null,
    optRange: null,
    macroEnd: 0,
    title: null,
    start: 0,
    headerEnd: 0,
    end: 0,
    children: [],
  }
  const root: DocumentNode = {
    id: "documento",
    kind: "documento",
    number: null,
    label: "Documento",
    title: null,
    file: entry,
    range: { start: 0, end: entryParse?.text.length ?? 0 },
    children: [],
    parent: null,
    parsed: entryParse?.root ?? emptyRoot,
  }
  const nodes = new Map<string, DocumentNode>()
  const seen = new Map<string, string>()

  const build = (parsed: ParsedNode, file: string, parent: DocumentNode, number: string): DocumentNode => {
    const kind = parsed.kind as Exclude<ParsedNode["kind"], "file">
    const id = kind === "lettera" || parsed.id === null ? `${parent.id}.${number}` : parsed.id
    let label: string
    if (kind === "comma") label = `comma ${number}`
    else if (kind === "lettera") label = `lettera ${number})`
    else label = `${KIND_LABEL[kind]} ${number}`
    const node: DocumentNode = {
      id,
      kind,
      number,
      label,
      title: plainTitle(parsed.title),
      file,
      range: { start: parsed.start, end: parsed.end },
      children: [],
      parent: parent.id,
      parsed,
    }
    if (parsed.id !== null && kind !== "lettera") {
      const previous = seen.get(parsed.id)
      if (previous !== undefined) {
        issueAt(
          file,
          parsed.idRange?.start ?? parsed.start,
          "duplicate_id",
          `Id ${parsed.id} già usato in ${previous} (viene riassegnato automaticamente)`,
          "error"
        )
      } else {
        seen.set(parsed.id, file)
        nodes.set(parsed.id, node)
      }
    }
    // Capi and articles share a counter at each level, as sections do; commi and lettere count within their parent.
    let level = 0
    let commi = 0
    let lettere = 0
    for (const child of childrenOf(parsed, file)) {
      let childNumber: string
      if (child.parsed.kind === "capo" || child.parsed.kind === "articolo") childNumber = `${number}.${++level}`
      else if (child.parsed.kind === "comma") childNumber = String(++commi)
      else childNumber = letterOf(++lettere)
      node.children.push(build(child.parsed, child.file, node, childNumber))
    }
    return node
  }

  let regolamenti = 0
  if (entryParse)
    for (const child of childrenOf(entryParse.root, entry))
      root.children.push(build(child.parsed, child.file, root, String(++regolamenti)))

  // Cross-references must point to an existing node.
  for (const path of order) {
    const p = parses.get(path)
    if (!p) continue
    for (const ref of p.refs)
      if (!nodes.has(ref.id))
        issueAt(path, ref.start, "unknown_ref", `\\rif{${ref.id}}: nessun elemento con questo id`, "error", ref.end)
  }

  const rank = (file: string) => {
    const index = order.indexOf(file)
    return index < 0 ? order.length : index
  }
  issues.sort((a, b) => (a.file === b.file ? a.offset - b.offset : rank(a.file) - rank(b.file)))
  return { parses: !issues.some((x) => x.severity === "error"), tree: root, issues, files: parses, order, nodes }
}

/** The tree as the contract exposes it (no parser internals). */
export function toStructure(node: DocumentNode): StructureNode {
  return {
    id: node.id,
    kind: node.kind,
    number: node.number,
    label: node.label,
    title: node.title,
    file: node.file,
    range: node.range,
    children: node.children.map(toStructure),
  }
}

/** "articolo 2.3 comma 4 lettera b)": how a `\rif` reads today. */
export function refLabel(doc: ParsedDocument, id: string): string | null {
  const node = doc.nodes.get(id)
  if (!node) return null
  const chain: DocumentNode[] = []
  let current: DocumentNode | undefined = node
  while (current && current.kind !== "documento") {
    chain.unshift(current)
    current = current.parent ? (doc.nodes.get(current.parent) ?? findById(doc.tree, current.parent)) : undefined
  }
  const article = chain.find((n) => n.kind === "articolo")
  const parts: string[] = []
  if (node.kind === "regolamento" || node.kind === "capo") return `${node.kind} ${node.number}`
  if (article) parts.push(`articolo ${article.number}`)
  for (const n of chain) if (n.kind === "comma" || n.kind === "lettera") parts.push(n.label)
  return parts.join(" ")
}

export function findById(node: DocumentNode, id: string): DocumentNode | undefined {
  if (node.id === id) return node
  for (const child of node.children) {
    const found = findById(child, id)
    if (found) return found
  }
  return undefined
}

/** All nodes of the tree, depth-first. */
export function* walk(node: DocumentNode): Generator<DocumentNode> {
  yield node
  for (const child of node.children) yield* walk(child)
}
