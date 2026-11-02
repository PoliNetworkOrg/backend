import { diffWordsWithSpace } from "diff"
import type { ArticleChange, Files } from "../contract"
import { type DocumentNode, type ParsedDocument, parseDocument, walk } from "./document"
import { articleText, renderInline } from "./plain"

/**
 * Structural diff between two versions of a document, matched by stable id. Articles are the unit: added, removed,
 * modified (their LaTeX changed), moved (same text, another place or parent) or renumbered (same text and place, a
 * different number because something before them changed). Everything else (regolamenti and capi added, removed or
 * retitled; free text and preamble) is reported as short descriptions.
 */
export type StructuralDiff = { articles: ArticleChange[]; otherChanges: string[] }

const normalize = (s: string) => s.replace(/\s+/g, " ").trim()

function rawText(doc: ParsedDocument, node: DocumentNode) {
  return normalize((doc.files.get(node.file)?.text ?? "").slice(node.range.start, node.range.end))
}

function articleLabel(node: DocumentNode) {
  return node.title ? `${node.label} — ${node.title}` : node.label
}

/** Indices of the longest increasing subsequence of `values`. */
export function lis(values: number[]): Set<number> {
  const tails: number[] = []
  const prev = new Array<number>(values.length).fill(-1)
  values.forEach((v, i) => {
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (values[tails[mid]] < v) lo = mid + 1
      else hi = mid
    }
    if (lo > 0) prev[i] = tails[lo - 1]
    tails[lo] = i
  })
  const out = new Set<number>()
  let k = tails.length ? tails[tails.length - 1] : -1
  while (k >= 0) {
    out.add(k)
    k = prev[k]
  }
  return out
}

export function wordDiff(oldText: string, newText: string): ArticleChange["words"] {
  if (oldText === newText) return []
  return diffWordsWithSpace(oldText, newText).map((part) => ({
    op: part.added ? "insert" : part.removed ? "delete" : "equal",
    text: part.value,
  }))
}

export function diffDocuments(oldFiles: Files, newFiles: Files, entry: string): StructuralDiff {
  return diffParsed(parseDocument(oldFiles, entry), parseDocument(newFiles, entry))
}

export function diffParsed(oldDoc: ParsedDocument, newDoc: ParsedDocument): StructuralDiff {
  const articlesOf = (doc: ParsedDocument) => [...walk(doc.tree)].filter((n) => n.kind === "articolo")
  const oldArticles = articlesOf(oldDoc)
  const newArticles = articlesOf(newDoc)
  const oldIndex = new Map(oldArticles.map((a, i) => [a.id, i]))
  const newById = new Map(newArticles.map((a) => [a.id, a]))

  const common = newArticles.filter((a) => oldIndex.has(a.id))
  const inOrder = lis(common.map((a) => oldIndex.get(a.id) as number))
  const outOfOrder = new Set(common.filter((_, i) => !inOrder.has(i)).map((a) => a.id))

  const changes: { change: ArticleChange; position: number }[] = []
  newArticles.forEach((node, position) => {
    const oldNode = oldIndex.has(node.id) ? oldArticles[oldIndex.get(node.id) as number] : undefined
    const newText = articleText(newDoc, node)
    if (!oldNode) {
      changes.push({
        position,
        change: {
          id: node.id,
          kind: "added",
          oldLabel: null,
          newLabel: articleLabel(node),
          oldText: null,
          newText,
          words: [],
          moved: null,
        },
      })
      return
    }
    const oldText = articleText(oldDoc, oldNode)
    const moved = oldNode.parent !== node.parent || outOfOrder.has(node.id)
    const modified = rawText(oldDoc, oldNode) !== rawText(newDoc, node)
    const base = {
      id: node.id,
      oldLabel: articleLabel(oldNode),
      newLabel: articleLabel(node),
      oldText,
      newText,
      words: wordDiff(oldText, newText),
    }
    if (modified)
      changes.push({
        position,
        change: { ...base, kind: "modified", moved: moved ? { from: oldNode.label, to: node.label } : null },
      })
    else if (moved)
      changes.push({ position, change: { ...base, kind: "moved", moved: { from: oldNode.label, to: node.label } } })
    else if (oldNode.number !== node.number)
      changes.push({ position, change: { ...base, kind: "renumbered", moved: null } })
  })
  // Removed articles go after the article that preceded them in the old version.
  oldArticles.forEach((node, index) => {
    if (newById.has(node.id)) return
    let position = -0.5
    for (let p = index - 1; p >= 0; p--) {
      const at = newArticles.findIndex((a) => a.id === oldArticles[p].id)
      if (at >= 0) {
        position = at + 0.5
        break
      }
    }
    const oldText = articleText(oldDoc, node)
    changes.push({
      position: position + index / 1e6,
      change: {
        id: node.id,
        kind: "removed",
        oldLabel: articleLabel(node),
        newLabel: null,
        oldText,
        newText: null,
        words: [],
        moved: null,
      },
    })
  })
  changes.sort((a, b) => a.position - b.position)

  return { articles: changes.map((c) => c.change), otherChanges: otherChanges(oldDoc, newDoc) }
}

function otherChanges(oldDoc: ParsedDocument, newDoc: ParsedDocument): string[] {
  const out: string[] = []
  const groups = (doc: ParsedDocument) =>
    new Map([...walk(doc.tree)].filter((n) => n.kind === "regolamento" || n.kind === "capo").map((n) => [n.id, n]))
  const oldGroups = groups(oldDoc)
  const newGroups = groups(newDoc)
  const name = (n: DocumentNode) => (n.kind === "regolamento" ? `il ${n.label}` : `il ${n.label}`)
  for (const [id, node] of newGroups) {
    const old = oldGroups.get(id)
    if (!old) {
      out.push(`Aggiunto ${name(node)} «${node.title ?? ""}»`)
      continue
    }
    if ((old.title ?? "") !== (node.title ?? ""))
      out.push(`${node.label}: titolo cambiato da «${old.title ?? ""}» a «${node.title ?? ""}»`)
    if (old.number !== node.number && old.kind === "regolamento")
      out.push(`«${node.title ?? ""}» passa da ${old.label} a ${node.label}`)
    const intro = (doc: ParsedDocument, n: DocumentNode) => {
      const text = doc.files.get(n.file)?.text ?? ""
      return normalize(text.slice(n.parsed.headerEnd, n.parsed.children[0]?.start ?? n.parsed.end))
    }
    if (intro(oldDoc, old) !== intro(newDoc, node)) out.push(`${node.label}: modificato il testo introduttivo`)
  }
  for (const [id, node] of oldGroups) if (!newGroups.has(id)) out.push(`Rimosso ${name(node)} «${node.title ?? ""}»`)

  // Text outside every regolamento: preamble, front matter, closing text.
  const freeText = (doc: ParsedDocument, path: string) => {
    const fp = doc.files.get(path)
    if (!fp) return null
    const first = fp.root.children[0]
    const last = fp.root.children[fp.root.children.length - 1]
    return normalize(fp.text.slice(0, first?.start ?? fp.text.length) + (last ? fp.text.slice(last.end) : ""))
  }
  const paths = new Set([...oldDoc.files.keys(), ...newDoc.files.keys()])
  for (const path of paths) {
    const before = freeText(oldDoc, path)
    const after = freeText(newDoc, path)
    if (before === null) out.push(`Aggiunto il file ${path}`)
    else if (after === null) out.push(`Rimosso il file ${path}`)
    else if (before !== after) out.push(`Modificato il testo fuori dagli articoli in ${path}`)
  }
  return out
}

export { renderInline }
