import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { assertSignatureOnlyUpdate } from "@/esign/pdf/diff"
import { addSignaturePlaceholder, type PlaceholderOptions } from "@/esign/pdf/incremental"
import { appendRevision, samplePdf } from "./esign-fixtures"

const options: PlaceholderOptions = {
  placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
  fieldName: "Signature1",
  signerName: "ROSSI MARIO",
  signingTime: new Date("2026-10-17T10:00:00Z"),
  appearance: { lines: [{ text: "ROSSI MARIO" }] },
}

const sig =
  "<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /ByteRange [0 0 0 0] /Contents <00> >>"
const appearance = "<< /Type /XObject /Subtype /Form /BBox [0 0 150 50] /Length 0 >>\nstream\n\nendstream"

/** Appends a revision with the objects `change` returns; it gets the document and the first free object number. */
async function revise(pdf: Uint8Array, change: (doc: PDFDocument, n: number) => Record<number, string>) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false })
  const objects = change(doc, doc.context.largestObjectNumber + 1)
  return appendRevision(
    pdf,
    objects,
    Math.max(doc.context.largestObjectNumber, ...Object.keys(objects).map(Number)) + 1
  )
}

/** The first page with `refs` appended to its annotations. */
function onPage(doc: PDFDocument, ...refs: PDFRef[]) {
  const page = doc.getPage(0)
  const annots = doc.context.lookupMaybe(page.node.get(PDFName.of("Annots")), PDFArray) ?? doc.context.obj([])
  for (const ref of refs) annots.push(ref)
  page.node.set(PDFName.of("Annots"), annots)
  return { [page.ref.objectNumber]: page.node.toString() }
}

/** The catalog with its form replaced by `form`. */
function withForm(doc: PDFDocument, form: PDFDict) {
  doc.catalog.set(PDFName.of("AcroForm"), form)
  return { [(doc.context.trailerInfo.Root as PDFRef).objectNumber]: doc.catalog.toString() }
}

const firstField = (doc: PDFDocument) => {
  const form = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")), PDFDict)
  return doc.context.lookup(form.get(PDFName.of("Fields")), PDFArray).get(0) as PDFRef
}

const original = await samplePdf(1)
const signed = (await addSignaturePlaceholder(original, options)).pdf

async function assertUpdate(before: Uint8Array, after: Uint8Array) {
  const doc = await PDFDocument.load(after, { updateMetadata: false })
  const form = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")), PDFDict)
  const field = doc.context
    .lookup(form.get(PDFName.of("Fields")), PDFArray)
    .asArray()
    .at(-1)
  const value = doc.context.lookup(field, PDFDict).get(PDFName.of("V"))
  if (!(field instanceof PDFRef && value instanceof PDFRef)) throw new Error("missing signature reference")
  return assertSignatureOnlyUpdate(before, after, { field: field.toString(), value: value.toString() })
}

async function refused(after: Uint8Array, what: RegExp, before = signed) {
  const added = await addSignaturePlaceholder(after, { ...options, fieldName: "NewSignature" })
  await expect(assertUpdate(before, added.pdf)).rejects.toThrow(what)
}

describe("assertSignatureOnlyUpdate", () => {
  it("accepts a first and a second signature", async () => {
    await expect(assertUpdate(original, signed)).resolves.toBeUndefined()
    const second = (await addSignaturePlaceholder(signed, { ...options, fieldName: "Signature2" })).pdf
    await expect(assertUpdate(signed, second)).resolves.toBeUndefined()
  })

  it("accepts filling an existing empty signature field", async () => {
    const empty = await revise(original, (doc, n) => ({
      [n]: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Firma) /F 4 /Rect [50 50 200 100] /P ${doc.getPage(0).ref} >>`,
      ...onPage(doc, PDFRef.of(n)),
      ...withForm(doc, doc.context.obj({ Fields: [PDFRef.of(n)] })),
    }))
    const fill = (value: string) =>
      revise(empty, (doc, n) => {
        const ref = firstField(doc)
        const field = doc.context.lookup(ref, PDFDict)
        field.set(PDFName.of("V"), PDFRef.of(n))
        field.set(PDFName.of("AP"), doc.context.obj({ N: PDFRef.of(n + 1) }))
        return { [ref.objectNumber]: field.toString(), [n]: value, [n + 1]: appearance }
      })
    await expect(assertUpdate(empty, await fill(sig))).resolves.toBeUndefined()
    await refused(await fill("<< /Foo /Bar >>"), /changes the document \(object/, empty)
  })

  it("refuses a dummy signature value beside the actual signature", async () => {
    const edited = await revise(signed, (doc, n) => ({
      [n]: `<< /Type /Annot /Subtype /Widget /FT /Sig /V ${n + 1} 0 R /Rect [0 0 150 50] >>`,
      [n + 1]: "<< /ByteRange [0 0 0 0] >>",
      ...onPage(doc, PDFRef.of(n)),
    }))
    await refused(edited, /annotation that is not the signature/)
  })

  for (const parent of [false, true]) {
    it(`refuses an unrelated widget referencing the actual signature via ${parent ? "Parent" : "V"}`, async () => {
      const second = (await addSignaturePlaceholder(signed, { ...options, fieldName: "Signature2" })).pdf
      const edited = await revise(second, (doc, n) => {
        const form = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")), PDFDict)
        const field = doc.context
          .lookup(form.get(PDFName.of("Fields")), PDFArray)
          .asArray()
          .at(-1)
        const value = doc.context.lookup(field, PDFDict).get(PDFName.of("V"))
        return {
          [n]: `<< /Type /Annot /Subtype /Widget ${parent ? `/Parent ${field}` : `/FT /Sig /V ${value}`} /Rect [0 0 150 50] >>`,
          ...onPage(doc, PDFRef.of(n)),
        }
      })
      await expect(assertUpdate(signed, edited)).rejects.toThrow(/annotation that is not the signature/)
    })
  }

  it("accepts a separate widget belonging to the signature field", async () => {
    const second = (await addSignaturePlaceholder(signed, { ...options, fieldName: "Signature2" })).pdf
    const edited = await revise(second, (doc, n) => {
      const form = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")), PDFDict)
      const ref = doc.context
        .lookup(form.get(PDFName.of("Fields")), PDFArray)
        .asArray()
        .at(-1) as PDFRef
      const field = doc.context.lookup(ref, PDFDict)
      field.delete(PDFName.of("Subtype"))
      field.set(PDFName.of("Kids"), doc.context.obj([PDFRef.of(n)]))
      const page = doc.getPage(0)
      const annots = doc.context.lookup(page.node.get(PDFName.of("Annots")), PDFArray)
      annots.set(annots.size() - 1, PDFRef.of(n))
      return {
        [ref.objectNumber]: field.toString(),
        [page.ref.objectNumber]: page.node.toString(),
        [n]: `<< /Type /Annot /Subtype /Widget /Parent ${ref} /Rect [0 0 150 50] >>`,
      }
    })
    await expect(assertUpdate(signed, edited)).resolves.toBeUndefined()
  })

  it("refuses non-widget children hidden under the signature field", async () => {
    const second = (await addSignaturePlaceholder(signed, { ...options, fieldName: "Signature2" })).pdf
    const edited = await revise(second, (doc, n) => {
      const form = doc.context.lookup(doc.catalog.get(PDFName.of("AcroForm")), PDFDict)
      const ref = doc.context
        .lookup(form.get(PDFName.of("Fields")), PDFArray)
        .asArray()
        .at(-1) as PDFRef
      const field = doc.context.lookup(ref, PDFDict)
      field.set(PDFName.of("Kids"), doc.context.obj([PDFRef.of(n)]))
      return { [ref.objectNumber]: field.toString(), [n]: "<< /FT /Tx /T (extra) >>" }
    })
    await expect(assertUpdate(signed, edited)).rejects.toThrow(/changes the document/)
  })

  it("refuses annotations other than the signature widget", async () => {
    const annotation = (body: (n: number) => string) =>
      revise(signed, (doc, n) => ({ [n]: body(n), [n + 1]: sig, ...onPage(doc, PDFRef.of(n)) }))
    const notSignature = /annotation that is not the signature on page 1/
    // Text drawn over the page.
    await refused(
      await annotation(() => "<< /Type /Annot /Subtype /FreeText /Rect [50 700 300 740] /Contents (Nuovo testo) >>"),
      notSignature
    )
    // A link that opens a page.
    await refused(
      await annotation(
        () => "<< /Type /Annot /Subtype /Link /Rect [0 0 595 842] /A << /S /URI /URI (https://x.example) >> >>"
      ),
      notSignature
    )
    // A text field.
    await refused(
      await annotation(() => "<< /Type /Annot /Subtype /Widget /FT /Tx /T (x) /V (y) /Rect [0 0 9 9] >>"),
      notSignature
    )
    // A signature widget that runs a script, or shows no new signature.
    await refused(
      await annotation(
        (n) =>
          `<< /Type /Annot /Subtype /Widget /FT /Sig /T (S2) /V ${n + 1} 0 R /Rect [0 0 9 9] ` +
          "/AA << /PO << /S /JavaScript /JS (app.alert(1)) >> >> >>"
      ),
      notSignature
    )
    await refused(
      await annotation(() => "<< /Type /Annot /Subtype /Widget /FT /Sig /T (S2) /Rect [0 0 9 9] >>"),
      notSignature
    )
    // A second widget for the earlier signature, with an appearance of its own.
    const earlier = await revise(signed, (doc, n) => {
      const value = doc.context.lookup(firstField(doc), PDFDict).get(PDFName.of("V"))
      return {
        [n]: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (S2) /V ${value} /Rect [0 0 595 842] /AP << /N ${n + 1} 0 R >> >>`,
        [n + 1]: appearance,
        ...onPage(doc, PDFRef.of(n)),
      }
    })
    await refused(earlier, notSignature)
    // Stamps like the agent's marks: an uploaded file has no reason to add them.
    const marked = await addSignaturePlaceholder(signed, {
      ...options,
      fieldName: "Signature2",
      marks: [options.placement],
    })
    await refused(marked.pdf, notSignature)
  })

  it("refuses form fields and form entries other than the signature's", async () => {
    // A hidden field that runs a script, not on any page.
    const hidden = await revise(signed, (doc, n) => {
      const ref = doc.catalog.get(PDFName.of("AcroForm")) as PDFRef
      const form = doc.context.lookup(ref, PDFDict)
      doc.context.lookup(form.get(PDFName.of("Fields")), PDFArray).push(PDFRef.of(n))
      return {
        [n]: "<< /FT /Tx /T (x) /AA << /C << /S /JavaScript /JS (app.alert(1)) >> >> >>",
        [ref.objectNumber]: form.toString(),
      }
    })
    await refused(hidden, /form field that is not the signature/)
    // An XFA form, which viewers draw instead of the pages, added to a form held in the catalog.
    const inline = await revise(original, (doc) => withForm(doc, doc.context.obj({ Fields: [] })))
    const xfa = await revise(inline, (doc, n) => ({
      [n]: "<< /Length 0 >>\nstream\n\nendstream",
      ...withForm(doc, doc.context.obj({ Fields: [], XFA: PDFRef.of(n) })),
    }))
    await refused(xfa, /\/XFA of the form/, inline)
  })
})
