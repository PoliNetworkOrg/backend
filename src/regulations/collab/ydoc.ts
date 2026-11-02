import { diffChars } from "diff"
import * as Y from "yjs"
import type { Files } from "../contract"
import type { TextEdit } from "../latex"

/** The Y.Doc layout shared with the dashboard: `getMap("files")` maps each source path to its `Y.Text`. */
export const FILES_MAP = "files"

export function filesMap(doc: Y.Doc): Y.Map<Y.Text> {
  return doc.getMap<Y.Text>(FILES_MAP)
}

export function filesFromDoc(doc: Y.Doc): Files {
  const out: Files = {}
  for (const [path, text] of filesMap(doc).entries()) out[path] = text.toString()
  return out
}

/** A new document holding `files`, as one update (stored when a draft is created). */
export function encodeFiles(files: Files): Uint8Array {
  const doc = new Y.Doc()
  doc.transact(() => {
    const map = filesMap(doc)
    for (const [path, content] of Object.entries(files)) {
      const text = new Y.Text()
      map.set(path, text)
      text.insert(0, content)
    }
  })
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

export function decodeFiles(state: Uint8Array): Files {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, state)
  const files = filesFromDoc(doc)
  doc.destroy()
  return files
}

/** Edits a `Y.Text` into `next` with the smallest change it can find, so concurrent edits elsewhere survive. */
function retext(text: Y.Text, next: string) {
  const current = text.toString()
  if (current === next) return
  const changes = diffChars(current, next, { maxEditLength: 20_000 })
  if (!changes) {
    text.delete(0, text.length)
    text.insert(0, next)
    return
  }
  let index = 0
  for (const change of changes) {
    if (change.added) {
      text.insert(index, change.value)
      index += change.value.length
    } else if (change.removed) text.delete(index, change.value.length)
    else index += change.value.length
  }
}

/** Makes the document hold exactly `files` (restore, merge): files added, removed, and edited in place. */
export function replaceFiles(doc: Y.Doc, files: Files, origin?: unknown) {
  doc.transact(() => {
    const map = filesMap(doc)
    for (const path of [...map.keys()]) if (!(path in files)) map.delete(path)
    for (const [path, content] of Object.entries(files)) {
      const existing = map.get(path)
      if (existing) retext(existing, content)
      else {
        const text = new Y.Text()
        map.set(path, text)
        text.insert(0, content)
      }
    }
  }, origin)
}

/** Applies text edits (e.g. id insertions), each file from its end so offsets stay valid. */
export function applyTextEdits(doc: Y.Doc, edits: TextEdit[], origin?: unknown) {
  if (!edits.length) return
  doc.transact(() => {
    const map = filesMap(doc)
    for (const edit of [...edits].sort((a, b) => (a.file === b.file ? b.start - a.start : 0))) {
      const text = map.get(edit.file)
      if (!text) continue
      if (edit.end > edit.start) text.delete(edit.start, edit.end - edit.start)
      if (edit.insert) text.insert(edit.start, edit.insert)
    }
  }, origin)
}
