export { applyDelibera, type DeliberaInput, DeliberaMacroMissing, escapeLatex } from "./delibera"
export { diffDocuments, diffParsed, type StructuralDiff, wordDiff } from "./diff"
export {
  type DocumentNode,
  findById,
  type ParsedDocument,
  parseDocument,
  refLabel,
  toStructure,
  walk,
} from "./document"
export { applyEdits, ensureIds, generateId, idEdits, type TextEdit } from "./ids"
export { type MergeOutcome, merge3, type Resolution, roundTrip, unitTexts } from "./merge"
export { ID_PATTERN, normalizePath, parseFile } from "./parse"
export { articleText, renderInline } from "./plain"

import type { Files, Structure } from "../contract"
import { parseDocument, toStructure } from "./document"

/** The contract's view of a document's structure. */
export function structureOf(files: Files, entry: string): Structure {
  const doc = parseDocument(files, entry)
  return { parses: doc.parses, tree: toStructure(doc.tree), issues: doc.issues }
}
