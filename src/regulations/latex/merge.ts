import type { Files, MergeConflict, NodeKind } from "../contract"
import { lis } from "./diff"
import { type DocumentNode, type ParsedDocument, parseDocument, walk } from "./document"
import type { ParsedNode } from "./parse"

/**
 * Structural 3-way merge per node (spec decision 5). Each file is a tree of merge units keyed by stable id:
 * file → regolamento → capo → articolo → comma. A comma is the smallest unit (its lettere are part of it). Each unit
 * has its own text (`head`: the heading and the body before its first child; a leaf's whole text), the text after its
 * last child (`tail`, e.g. `\end{commi}`), and the text between it and its next sibling (`after`).
 *
 * Different units merge automatically; the same unit changed on both sides (or changed on one, deleted on the other)
 * is a conflict. Order and parent are merged too, so an article added or moved in one draft lands where it was put,
 * and numbering follows from order. Serializing a parsed tree gives back the exact text.
 */

type Unit = {
  key: string
  kind: NodeKind | "file"
  file: string
  head: string
  tail: string
  after: string
  /** Whether a sibling followed it: an empty `after` then means the two were adjacent. */
  hadNext: boolean
  children: string[]
  parent: string | null
}

type Side = { units: Map<string, Unit>; doc: ParsedDocument }

export type Resolution = "ours" | "theirs" | { text: string }

export type MergeOutcome = {
  /** Why it can't run, or `null`. */
  blockedBy: string | null
  /** The merged files, resolving open conflicts with `ours`. */
  files: Files
  conflicts: MergeConflict[]
  /** Conflicts not covered by the given resolutions. */
  unresolved: string[]
  applied: { nodeId: string; label: string; change: "added" | "removed" | "modified" | "moved" }[]
  warnings: string[]
}

const fileKey = (path: string) => `file:${path}`
const core = (text: string) => text.replace(/\s+$/, "")

function units(doc: ParsedDocument): Map<string, Unit> {
  const out = new Map<string, Unit>()
  const add = (
    node: ParsedNode,
    key: string,
    kind: Unit["kind"],
    file: string,
    text: string,
    parent: string | null
  ) => {
    const children = node.kind === "comma" ? [] : node.children.filter((c) => c.kind !== "lettera")
    const unit: Unit = {
      key,
      kind,
      file,
      head: children.length ? text.slice(node.start, children[0].start) : text.slice(node.start, node.end),
      tail: children.length ? text.slice(children[children.length - 1].end, node.end) : "",
      after: "",
      hadNext: false,
      children: [],
      parent,
    }
    out.set(key, unit)
    children.forEach((child, k) => {
      const childKey = child.id ?? `${key}/${k}`
      add(child, childKey, child.kind as NodeKind, file, text, key)
      const next = children[k + 1]
      const childUnit = out.get(childKey)
      if (childUnit && next) {
        childUnit.after = text.slice(child.end, next.start)
        childUnit.hadNext = true
      }
      unit.children.push(childKey)
    })
  }
  for (const [path, fp] of doc.files) add(fp.root, fileKey(path), "file", path, fp.text, null)
  return out
}

function serialize(key: string, get: (key: string) => Unit | undefined, order: Map<string, string[]>): string {
  const unit = get(key)
  if (!unit) return ""
  const children = order.get(key) ?? []
  let out = unit.head
  children.forEach((child, k) => {
    out += serialize(child, get, order)
    if (k === children.length - 1) return
    // A unit that was last had no gap after it: separate it from its new sibling.
    const unit = get(child)
    out += unit?.hadNext || /\s$/.test(out) ? (unit?.after ?? "") : "\n\n"
  })
  // The last child's `after` was the gap before a sibling that may now be gone; the parent's tail follows it.
  return out + unit.tail
}

/** Labels like "Articolo 2.3 (Titolo)" or "Articolo 2.3, comma 4". */
function labeler(doc: ParsedDocument) {
  const byId = new Map<string, DocumentNode>()
  for (const node of walk(doc.tree)) byId.set(node.id, node)
  return (key: string): string | null => {
    if (key.startsWith("file:")) return `File ${key.slice(5)}`
    const node = byId.get(key)
    if (!node) return null
    if (node.kind === "comma") {
      const parent = node.parent ? byId.get(node.parent) : undefined
      if (!parent) return node.label
      return parent.title ? `${parent.label} (${parent.title}), ${node.label}` : `${parent.label}, ${node.label}`
    }
    return node.title ? `${node.label} (${node.title})` : node.label
  }
}

function seqEqual(a: string[], b: string[]) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

function insertMissing(result: string[], source: string[], wanted: Set<string>) {
  source.forEach((key, index) => {
    if (!wanted.has(key) || result.includes(key)) return
    for (let p = index - 1; p >= 0; p--) {
      const at = result.indexOf(source[p])
      if (at >= 0) {
        result.splice(at + 1, 0, key)
        return
      }
    }
    for (let n = index + 1; n < source.length; n++) {
      const at = result.indexOf(source[n])
      if (at >= 0) {
        result.splice(at, 0, key)
        return
      }
    }
    result.push(key)
  })
}

export function merge3(
  input: { base: Files; ours: Files; theirs: Files; entry: string },
  resolutions: Record<string, Resolution> = {}
): MergeOutcome {
  const docs = {
    base: parseDocument(input.base, input.entry),
    ours: parseDocument(input.ours, input.entry),
    theirs: parseDocument(input.theirs, input.entry),
  }
  const empty: MergeOutcome = {
    blockedBy: null,
    files: input.ours,
    conflicts: [],
    unresolved: [],
    applied: [],
    warnings: [],
  }
  const names = { base: "nella base", ours: "in questa bozza", theirs: "nell'origine del merge" } as const
  for (const side of ["ours", "theirs", "base"] as const) {
    if (!docs[side].parses)
      return { ...empty, blockedBy: `Il testo ${names[side]} non è valido: correggi gli errori prima del merge.` }
    const missing = docs[side].issues.find((i) => i.code === "missing_id" || i.code === "duplicate_id")
    if (missing) return { ...empty, blockedBy: `Mancano degli id ${names[side]}: riprova tra qualche secondo.` }
  }
  const sides: Record<"base" | "ours" | "theirs", Side> = {
    base: { units: units(docs.base), doc: docs.base },
    ours: { units: units(docs.ours), doc: docs.ours },
    theirs: { units: units(docs.theirs), doc: docs.theirs },
  }
  const label = {
    base: labeler(docs.base),
    ours: labeler(docs.ours),
    theirs: labeler(docs.theirs),
  }
  const labelOf = (key: string) => label.ours(key) ?? label.theirs(key) ?? label.base(key) ?? key
  const B = sides.base.units
  const O = sides.ours.units
  const T = sides.theirs.units

  const conflicts: MergeConflict[] = []
  const unresolved: string[] = []
  const applied: MergeOutcome["applied"] = []
  const warnings: string[] = []

  /** Final unit per kept key (content and structure fields; children/parent are recomputed below). */
  const kept = new Map<string, Unit>()
  const keys = new Set([...O.keys(), ...T.keys(), ...B.keys()])

  const pick3 = (b: string | undefined, o: string, t: string) => (o === t ? o : o === (b ?? o) ? t : o)

  for (const key of keys) {
    const b = B.get(key)
    const o = O.get(key)
    const t = T.get(key)
    const conflict = (type: MergeConflict["type"]) => {
      const any = (o ?? t ?? b) as Unit
      conflicts.push({
        nodeId: key,
        kind: any.kind === "file" ? "documento" : any.kind,
        label: labelOf(key),
        file: any.file,
        type,
        base: b?.head ?? null,
        ours: o?.head ?? null,
        theirs: t?.head ?? null,
      })
      const r = resolutions[key]
      if (!r) unresolved.push(key)
      return r ?? "ours"
    }
    const keep = (unit: Unit, head = unit.head) => {
      const other = unit === o ? t : o
      kept.set(key, {
        ...unit,
        head,
        tail: other
          ? pick3(b?.tail, unit === o ? unit.tail : other.tail, unit === o ? other.tail : unit.tail)
          : unit.tail,
        after: other
          ? pick3(b?.after, unit === o ? unit.after : other.after, unit === o ? other.after : unit.after)
          : unit.after,
      })
    }

    // Trailing whitespace changes when a unit moves or its neighbours change: it doesn't make a change.
    const same = (x: Unit | undefined, y: Unit | undefined) => !!x && !!y && core(x.head) === core(y.head)
    if (o && t) {
      if (same(o, t)) keep(o)
      else if (b && same(o, b)) {
        keep(o, t.head)
        applied.push({ nodeId: key, label: labelOf(key), change: "modified" })
      } else if (b && same(t, b)) keep(o)
      else {
        const r = conflict(b ? "both_modified" : "both_added")
        if (r === "theirs") keep(o, t.head)
        else if (r === "ours") keep(o)
        else keep(o, r.text)
      }
    } else if (o && !t) {
      if (!b) keep(o)
      else if (same(o, b)) {
        // Deleted in theirs. Kept below anyway if something kept still lives inside it.
        applied.push({ nodeId: key, label: labelOf(key), change: "removed" })
      } else {
        const r = conflict("modified_deleted")
        if (r === "ours") keep(o)
        else if (r !== "theirs") keep(o, r.text)
      }
    } else if (!o && t) {
      if (!b) {
        keep(t)
        applied.push({ nodeId: key, label: labelOf(key), change: "added" })
      } else if (!same(t, b)) {
        const r = conflict("deleted_modified")
        if (r === "theirs") keep(t)
        else if (r !== "ours") keep(t, r.text)
      }
    }
  }

  // Parents: a change of parent on one side wins; a kept unit whose parent is gone brings its parent back.
  const parentOf = new Map<string, string | null>()
  const resolveParent = (key: string): string | null => {
    const b = B.get(key)?.parent
    const o = O.get(key)?.parent
    const t = T.get(key)?.parent
    const candidates: (string | null | undefined)[] =
      o !== undefined && t !== undefined ? (o === b ? [t, o] : [o, t]) : [o ?? t, b]
    for (const c of candidates) if (c === null || (c !== undefined && kept.has(c))) return c
    return candidates.find((c) => c !== undefined) ?? null
  }
  const pending = [...kept.keys()]
  while (pending.length) {
    const key = pending.pop() as string
    if (parentOf.has(key)) continue
    const parent = resolveParent(key)
    parentOf.set(key, parent)
    if (parent && !kept.has(parent)) {
      const unit = O.get(parent) ?? T.get(parent) ?? B.get(parent)
      if (unit) {
        kept.set(parent, unit)
        warnings.push(`${labelOf(parent)} è stato mantenuto perché contiene parti modificate.`)
        const index = applied.findIndex((a) => a.nodeId === parent && a.change === "removed")
        if (index >= 0) applied.splice(index, 1)
        pending.push(parent)
      }
    }
  }
  for (const key of kept.keys()) {
    const b = B.get(key)?.parent
    const o = O.get(key)?.parent
    const t = T.get(key)?.parent
    if (b !== undefined && o === b && t !== undefined && t !== b && parentOf.get(key) === t)
      applied.push({ nodeId: key, label: labelOf(key), change: "moved" })
  }

  // Order within each parent.
  const order = new Map<string, string[]>()
  const childrenIn = (units: Map<string, Unit>, parent: string, wanted: Set<string>) =>
    (units.get(parent)?.children ?? []).filter((k) => wanted.has(k))
  const byParent = new Map<string, Set<string>>()
  for (const [key, parent] of parentOf) {
    if (parent === null) continue
    const set = byParent.get(parent) ?? new Set<string>()
    set.add(key)
    byParent.set(parent, set)
  }
  for (const [parent, wanted] of byParent) {
    const o = childrenIn(O, parent, wanted)
    const t = childrenIn(T, parent, wanted)
    const b = childrenIn(B, parent, wanted)
    const common = (x: string[], y: string[]) => x.filter((k) => y.includes(k))
    const oursKept = seqEqual(common(o, b), common(b, o))
    const theirsKept = seqEqual(common(t, b), common(b, t))
    let result: string[]
    if (oursKept && !theirsKept) {
      result = [...t]
      insertMissing(result, o, wanted)
      // Units theirs moved within this parent.
      const inBase = t.filter((k) => b.includes(k))
      const stay = lis(inBase.map((k) => b.indexOf(k)))
      inBase.forEach((key, i) => {
        if (!stay.has(i) && !applied.some((a) => a.nodeId === key && a.change === "moved"))
          applied.push({ nodeId: key, label: labelOf(key), change: "moved" })
      })
    } else {
      result = [...o]
      insertMissing(result, t, wanted)
      if (!oursKept && !theirsKept && !seqEqual(common(o, t), common(t, o)))
        warnings.push(
          `Entrambe le versioni hanno riordinato ${labelOf(parent)}: è stato tenuto l'ordine di questa bozza.`
        )
    }
    for (const key of wanted) if (!result.includes(key)) result.push(key)
    order.set(parent, result)
  }

  const files: Files = {}
  for (const [key, unit] of kept) {
    if (unit.kind !== "file") continue
    files[unit.file] = serialize(key, (k) => kept.get(k), order)
  }
  return { blockedBy: null, files, conflicts, unresolved, applied, warnings }
}

/** The text of every unit by key, for tests and the conflict UI. */
export function unitTexts(files: Files, entry: string): Map<string, string> {
  const doc = parseDocument(files, entry)
  const out = new Map<string, string>()
  for (const [key, unit] of units(doc)) out.set(key, unit.head)
  return out
}

/** Serializing a parsed document back gives the same files (used to check the decomposition is lossless). */
export function roundTrip(files: Files, entry: string): Files {
  const doc = parseDocument(files, entry)
  const all = units(doc)
  const order = new Map<string, string[]>()
  for (const [key, unit] of all) order.set(key, unit.children)
  const out: Files = {}
  for (const [key, unit] of all) if (unit.kind === "file") out[unit.file] = serialize(key, (k) => all.get(k), order)
  return out
}
