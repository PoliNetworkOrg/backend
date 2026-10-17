import { PDFArray, PDFDict, PDFDocument, PDFName, type PDFObject, PDFRawStream, PDFRef } from "pdf-lib"
import { PdfError } from "./incremental"

/** Keys a signing update may change, per kind of existing object. */
const PAGE_KEYS = new Set(["/Annots"])
const CATALOG_KEYS = new Set(["/AcroForm", "/Metadata", "/DSS", "/Extensions", "/Version"])
const ACROFORM_KEYS = new Set(["/Fields", "/SigFlags", "/DR", "/DA", "/NeedAppearances"])
/** An existing, empty signature field being signed. */
const SIGNATURE_FIELD_KEYS = new Set(["/V", "/AP", "/F", "/MK", "/DR"])

function bytes(obj: PDFObject): Buffer {
  const out = new Uint8Array(obj.sizeInBytes())
  obj.copyBytesInto(out, 0)
  return Buffer.from(out)
}

const same = (a: PDFObject | undefined, b: PDFObject | undefined) =>
  a === undefined || b === undefined ? a === b : bytes(a).equals(bytes(b))

function changedKeys(before: PDFDict, after: PDFDict): string[] {
  const keys = new Set([...before.keys(), ...after.keys()].map((k) => k.asString()))
  return [...keys].filter((key) => !same(before.get(PDFName.of(key.slice(1))), after.get(PDFName.of(key.slice(1)))))
}

/** `after` keeps every element of `before`, in order, and only appends. */
function appendsTo(before: PDFArray | undefined, after: PDFArray | undefined) {
  if (!before) return true
  if (!after || after.size() < before.size()) return false
  return before.asArray().every((item, i) => same(item, after.get(i)))
}

function load(pdf: Uint8Array) {
  return PDFDocument.load(pdf, { updateMetadata: false, throwOnInvalidObject: false, ignoreEncryption: false })
}

/**
 * Checks that `after` differs from `before` only by what adding an approval signature needs: new objects (signature,
 * widget, appearance, fonts), appended page annotations and form fields, form flags and resources, and metadata.
 * Anything else — page content, page boxes, resources, other objects — is refused, so a signer can't change the
 * document in the same revision they sign.
 */
export async function assertSignatureOnlyUpdate(before: Uint8Array, after: Uint8Array): Promise<void> {
  const refuse = (what: string) => {
    throw new PdfError("malformed", `The signed file changes the document (${what}), not only adds a signature`)
  }
  const [old, neu] = await Promise.all([load(before), load(after)])
  const oldRoot = old.context.trailerInfo.Root
  const newRoot = neu.context.trailerInfo.Root
  if (!(oldRoot instanceof PDFRef) || !(newRoot instanceof PDFRef) || oldRoot.toString() !== newRoot.toString())
    refuse("document catalog")

  const oldPages = old.getPages()
  const newPages = neu.getPages()
  if (oldPages.length !== newPages.length || oldPages.some((p, i) => p.ref.toString() !== newPages[i].ref.toString()))
    refuse("pages")

  const kinds = new Map<string, "page" | "catalog" | "acroform" | "annots" | "fields" | "info">()
  for (const page of oldPages) {
    kinds.set(page.ref.toString(), "page")
    const annots = page.node.get(PDFName.of("Annots"))
    if (annots instanceof PDFRef) kinds.set(annots.toString(), "annots")
  }
  kinds.set(String(oldRoot), "catalog")
  const acroForm = old.catalog.get(PDFName.of("AcroForm"))
  if (acroForm instanceof PDFRef) kinds.set(acroForm.toString(), "acroform")
  const acroFormDict = old.context.lookupMaybe(acroForm, PDFDict)
  const fields = acroFormDict?.get(PDFName.of("Fields"))
  if (fields instanceof PDFRef) kinds.set(fields.toString(), "fields")
  const info = old.context.trailerInfo.Info
  if (info instanceof PDFRef) kinds.set(info.toString(), "info")

  const oldObjects = new Map(old.context.enumerateIndirectObjects().map(([ref, obj]) => [ref.toString(), obj]))
  for (const [ref, obj] of neu.context.enumerateIndirectObjects()) {
    const key = ref.toString()
    const prev = oldObjects.get(key)
    if (!prev || same(prev, obj)) continue
    const kind = kinds.get(key)
    if (kind === "info") continue
    if (prev instanceof PDFRawStream && obj instanceof PDFRawStream) {
      const type = prev.dict.get(PDFName.of("Type"))
      if (type instanceof PDFName && type.asString() === "/Metadata") continue
      refuse(`object ${key}`)
    }
    if (kind === "annots" || kind === "fields") {
      if (!(prev instanceof PDFArray && obj instanceof PDFArray && appendsTo(prev, obj))) refuse(`object ${key}`)
      continue
    }
    if (!(prev instanceof PDFDict && obj instanceof PDFDict)) refuse(`object ${key}`)
    const before = prev as PDFDict
    const after = obj as PDFDict
    const changed = changedKeys(before, after)
    const allowed =
      kind === "page"
        ? PAGE_KEYS
        : kind === "catalog"
          ? CATALOG_KEYS
          : kind === "acroform"
            ? ACROFORM_KEYS
            : before.get(PDFName.of("FT"))?.toString() === "/Sig" && !before.has(PDFName.of("V"))
              ? SIGNATURE_FIELD_KEYS
              : new Set<string>()
    const extra = changed.find((k) => !allowed.has(k))
    if (extra) refuse(`${extra} of object ${key}`)
    if (kind === "page") {
      const annotsBefore = old.context.lookupMaybe(before.get(PDFName.of("Annots")), PDFArray)
      const annotsAfter = neu.context.lookupMaybe(after.get(PDFName.of("Annots")), PDFArray)
      if (!appendsTo(annotsBefore, annotsAfter)) refuse(`annotations of page object ${key}`)
    }
    if (kind === "acroform" || kind === "catalog") {
      const formBefore =
        kind === "acroform" ? before : old.context.lookupMaybe(before.get(PDFName.of("AcroForm")), PDFDict)
      const formAfter =
        kind === "acroform" ? after : neu.context.lookupMaybe(after.get(PDFName.of("AcroForm")), PDFDict)
      const fieldsBefore = formBefore
        ? old.context.lookupMaybe(formBefore.get(PDFName.of("Fields")), PDFArray)
        : undefined
      const fieldsAfter = formAfter ? neu.context.lookupMaybe(formAfter.get(PDFName.of("Fields")), PDFArray) : undefined
      if (!appendsTo(fieldsBefore, fieldsAfter)) refuse("form fields")
    }
  }
}
