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
 * widget, appearance, fonts), signature widgets appended to page annotations and form fields (each with a new
 * signature value and no actions), form flags and resources, and metadata. Anything else — page content, page boxes,
 * resources, other annotations, other objects — is refused, so a signer can't change the document in the same
 * revision they sign.
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

  /** Existing empty signature fields the update fills in. */
  const signedFields: [string, PDFDict][] = []
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
    if (allowed === SIGNATURE_FIELD_KEYS) signedFields.push([key, after])
  }

  // A viewer draws every annotation on a page and runs every action, so what the update adds there must be the new
  // signature's widget: anything else (a stamp, free text, a link, a script) would change what the document shows.
  const isNew = (ref: PDFObject | undefined): ref is PDFRef => ref instanceof PDFRef && !oldObjects.has(ref.toString())
  const indirect = (ref: PDFObject | undefined) =>
    ref instanceof PDFRef ? neu.context.lookupMaybe(ref, PDFDict) : undefined
  const hasAction = (dict: PDFDict) => dict.has(PDFName.of("A")) || dict.has(PDFName.of("AA"))
  const assertSignatureField = (field: PDFDict | undefined, what: string) => {
    const value = field?.get(PDFName.of("V"))
    if (
      !field ||
      field.get(PDFName.of("FT"))?.toString() !== "/Sig" ||
      hasAction(field) ||
      !isNew(value) ||
      !neu.context.lookupMaybe(value, PDFDict)?.has(PDFName.of("ByteRange"))
    )
      refuse(what)
  }
  for (const [key, field] of signedFields) assertSignatureField(field, `object ${key}`)
  newPages.forEach((page, i) => {
    const before = old.context.lookupMaybe(oldPages[i].node.get(PDFName.of("Annots")), PDFArray)
    const after = neu.context.lookupMaybe(page.node.get(PDFName.of("Annots")), PDFArray)
    if (!appendsTo(before, after)) refuse(`annotations of page ${i + 1}`)
    for (const ref of after?.asArray().slice(before?.size() ?? 0) ?? []) {
      const what = `an annotation that is not the signature on page ${i + 1}`
      const annot = indirect(ref)
      if (!annot || annot.get(PDFName.of("Subtype"))?.toString() !== "/Widget" || hasAction(annot)) refuse(what)
      const widget = annot as PDFDict
      assertSignatureField(widget.has(PDFName.of("FT")) ? widget : indirect(widget.get(PDFName.of("Parent"))), what)
    }
  })

  // The form may only gain signature fields, and only the keys signing needs (not /XFA, which viewers draw instead).
  const formBefore = old.context.lookupMaybe(old.catalog.get(PDFName.of("AcroForm")), PDFDict)
  const formAfter = neu.context.lookupMaybe(neu.catalog.get(PDFName.of("AcroForm")), PDFDict)
  const formKey = changedKeys(formBefore ?? old.context.obj({}), formAfter ?? neu.context.obj({})).find(
    (k) => !ACROFORM_KEYS.has(k)
  )
  if (formKey) refuse(`${formKey} of the form`)
  const fieldsBefore = formBefore ? old.context.lookupMaybe(formBefore.get(PDFName.of("Fields")), PDFArray) : undefined
  const fieldsAfter = formAfter ? neu.context.lookupMaybe(formAfter.get(PDFName.of("Fields")), PDFArray) : undefined
  if (!appendsTo(fieldsBefore, fieldsAfter)) refuse("form fields")
  for (const ref of fieldsAfter?.asArray().slice(fieldsBefore?.size() ?? 0) ?? [])
    assertSignatureField(indirect(ref), "a form field that is not the signature")
}
