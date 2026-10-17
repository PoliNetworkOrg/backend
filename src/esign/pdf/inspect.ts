import type { X509Certificate } from "node:crypto"
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib"
import { fiscalCodeOf } from "../identity"
import { displayedSize } from "./geometry"
import { PdfError } from "./incremental"
import { checkSignature } from "./pades"

export type PdfSignatureInfo = {
  fieldName: string
  /** /Name in the signature dictionary, else the certificate's common name. */
  signerName: string | null
  /** Italian fiscal code from the certificate's subject (see fiscalCodeOf). */
  fiscalCode: string | null
  issuer: string | null
  /** /M of the signature dictionary, as written. */
  signedAt: string | null
  subFilter: string | null
  intact: boolean
  verified: boolean
  coversWholeDocument: boolean
  /** Zero-based page of the widget, when it has one. */
  page: number | null
}

/** Indirect objects belonging to a signature, kept server-side for upload validation. */
export type PdfSignatureReference = { field: string; value: string }

export type PdfInfo = {
  /** The signer's certificate of the newest signature; server-side only, never sent to clients. */
  lastCertificate?: X509Certificate | null
  lastSignature?: PdfSignatureReference | null
  pages: { width: number; height: number }[]
  signatures: PdfSignatureInfo[]
  /** Field names in use, so a new field can get a unique one. */
  fieldNames: string[]
}

function text(value: unknown): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString) return value.decodeText()
  if (value instanceof PDFName) return value.decodeText()
  return null
}

/** Pages, existing signatures (checked cryptographically) and field names of a PDF. */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false })
  } catch (error) {
    if (error instanceof Error && error.name === "EncryptedPDFError")
      throw new PdfError("encrypted", "Encrypted PDFs cannot be signed")
    throw new PdfError("malformed", "Cannot read the PDF")
  }
  if (doc.isEncrypted) throw new PdfError("encrypted", "Encrypted PDFs cannot be signed")
  const pages = doc.getPages()
  const pageIndex = new Map(pages.map((p, i) => [p.ref.toString(), i]))
  const { context } = doc
  const signatures: (PdfSignatureInfo & {
    revisionEnd: number
    certificate: X509Certificate | null
    reference: PdfSignatureReference | null
  })[] = []
  const fieldNames: string[] = []

  const acroForm = context.lookupMaybe(doc.catalog.get(PDFName.of("AcroForm")), PDFDict)
  const fields = acroForm ? context.lookupMaybe(acroForm.get(PDFName.of("Fields")), PDFArray) : undefined

  // Field trees come from untrusted files: visit each object once, within a fixed budget, so cycles and wide or
  // repeated /Kids cannot make the walk explode.
  const seen = new Set<string>()
  let budget = 20_000
  const visit = (ref: unknown, parentName: string, depth: number) => {
    if (depth > 32 || --budget < 0) return
    if (ref instanceof PDFRef) {
      const key = ref.toString()
      if (seen.has(key)) return
      seen.add(key)
    }
    const field = context.lookupMaybe(ref as PDFRef, PDFDict)
    if (!field) return
    const partial = text(field.get(PDFName.of("T")))
    const name = partial === null ? parentName : parentName ? `${parentName}.${partial}` : partial
    const kids = context.lookupMaybe(field.get(PDFName.of("Kids")), PDFArray)
    if (kids) for (let i = 0; i < kids.size(); i++) visit(kids.get(i), name, depth + 1)
    if (partial !== null) fieldNames.push(name)
    const ft = field.get(PDFName.of("FT"))
    if (!(ft instanceof PDFName) || ft.asString() !== "/Sig") return
    const value = field.get(PDFName.of("V"))
    const sig = context.lookupMaybe(value, PDFDict)
    if (!sig) return
    const byteRangeArray = context.lookupMaybe(sig.get(PDFName.of("ByteRange")), PDFArray)
    const contents = sig.get(PDFName.of("Contents"))
    if (!byteRangeArray || !(contents instanceof PDFHexString || contents instanceof PDFString)) return
    const byteRange = byteRangeArray.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : -1))
    const check = checkSignature(bytes, byteRange, contents.asBytes())
    const cert = check.parsed?.certificate ?? null
    const subject = cert?.subject ?? ""
    const commonName = /(?:^|\n)CN=([^\n]+)/.exec(subject)?.[1] ?? null
    const issuerCn = cert ? (/(?:^|\n)CN=([^\n]+)/.exec(cert.issuer)?.[1] ?? cert.issuer) : null
    const widgetPage = field.get(PDFName.of("P"))
    signatures.push({
      fieldName: name,
      signerName: text(sig.get(PDFName.of("Name"))) ?? commonName,
      fiscalCode: fiscalCodeOf(subject),
      issuer: issuerCn,
      signedAt: text(sig.get(PDFName.of("M"))),
      subFilter: text(sig.get(PDFName.of("SubFilter"))),
      intact: check.intact,
      verified: check.verified,
      coversWholeDocument: check.coversWholeDocument,
      page: widgetPage instanceof PDFRef ? (pageIndex.get(widgetPage.toString()) ?? null) : null,
      revisionEnd: (byteRange[2] ?? 0) + (byteRange[3] ?? 0),
      certificate: cert,
      reference:
        ref instanceof PDFRef && value instanceof PDFRef ? { field: ref.toString(), value: value.toString() } : null,
    })
  }
  if (fields) for (let i = 0; i < fields.size(); i++) visit(fields.get(i), "", 0)

  // In signing order: each signature covers the revision it was added in.
  signatures.sort((a, b) => a.revisionEnd - b.revisionEnd)
  return {
    pages: pages.map((p) => displayedSize(p)),
    signatures: signatures.map(({ revisionEnd: _, certificate: __, reference: ___, ...info }) => info),
    fieldNames,
    lastCertificate: signatures.at(-1)?.certificate ?? null,
    lastSignature: signatures.at(-1)?.reference ?? null,
  }
}
