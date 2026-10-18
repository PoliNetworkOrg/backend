import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  type PDFObject,
  type PDFPage,
  PDFRef,
  PDFString,
  StandardFontEmbedder,
  StandardFonts,
} from "pdf-lib"
import { type Placement, rectOnPage } from "./geometry"

/** Bytes reserved for the CMS signature: room for the certificate chain and a future timestamp token. */
export const SIGNATURE_RESERVED_BYTES = 16_384

export class PdfError extends Error {
  constructor(
    readonly code: "encrypted" | "malformed" | "page_out_of_range" | "locked",
    message: string
  ) {
    super(message)
    this.name = "PdfError"
  }
}

export type SignatureAppearance = {
  /** Lines of text, top to bottom; the first is drawn bold. */
  lines: { text: string; bold?: boolean; muted?: boolean }[]
}

export type PlaceholderOptions = {
  placement: Placement
  /** More places showing the same mark, drawn in the same update so the signature covers them. */
  marks?: Placement[]
  /** Field name, unique in the document. */
  fieldName: string
  /** Signer's name for the signature dictionary's /Name. */
  signerName: string
  reason?: string
  location?: string
  signingTime: Date
  appearance: SignatureAppearance
}

export type Placeholder = {
  /** The document with the incremental update and a zero-filled /Contents. */
  pdf: Uint8Array
  /** `[0, a, b, c]`: the signed bytes are `[0, a)` and `[b, b + c)`. */
  byteRange: [number, number, number, number]
  /** Offset of the first hex digit inside `/Contents <…>` and the number of hex digits. */
  contentsOffset: number
  contentsHexLength: number
}

const latin1 = new TextDecoder("latin1")
const encoder = new TextEncoder()

/** Bytes of a string that only holds PDF syntax (ASCII). */
function ascii(s: string): Uint8Array {
  return encoder.encode(s)
}

function serialize(obj: PDFObject): Uint8Array {
  const out = new Uint8Array(obj.sizeInBytes())
  obj.copyBytesInto(out, 0)
  return out
}

/** A PDF literal string with every byte above ASCII or special escaped, from Latin-1/PDFDocEncoding text. */
export function pdfString(text: string): string {
  let out = "("
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 63
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`
    else if (code >= 32 && code < 127) out += ch
    else if (code < 256) out += `\\${code.toString(8).padStart(3, "0")}`
    else out += "?"
  }
  return `${out})`
}

/** A PDF text string: PDFDocEncoding when possible, else UTF-16BE with BOM as hex. */
export function pdfTextString(text: string): string {
  if ([...text].every((c) => (c.codePointAt(0) ?? 0) < 256)) return pdfString(text)
  let hex = "<FEFF"
  for (let i = 0; i < text.length; i++) hex += text.charCodeAt(i).toString(16).padStart(4, "0")
  return `${hex}>`
}

/** `D:YYYYMMDDHHmmSS+HH'mm'` in Europe/Rome, as Italian readers expect. */
export function pdfDate(date: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Rome",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  )
  const offset = /GMT([+-])(\d{2}):(\d{2})/.exec(parts.timeZoneName ?? "")
  const tz = offset ? `${offset[1]}${offset[2]}'${offset[3]}'` : "Z"
  return `D:${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}${tz}`
}

type Tail = { startxref: number; kind: "table" | "stream"; size: number }

/** Reads the last cross-reference section: where it starts, its kind and the trailer's /Size. */
function readTail(bytes: Uint8Array): Tail {
  const tail = latin1.decode(bytes.subarray(Math.max(0, bytes.length - 2048)))
  const match = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].at(-1)
  if (!match) throw new PdfError("malformed", "startxref not found")
  const startxref = Number(match[1])
  if (!Number.isSafeInteger(startxref) || startxref >= bytes.length) throw new PdfError("malformed", "bad startxref")
  const section = latin1.decode(bytes.subarray(startxref, Math.min(bytes.length, startxref + 64 * 1024)))
  let kind: Tail["kind"]
  let dict: string
  if (section.startsWith("xref")) {
    kind = "table"
    // A classic table has 20 bytes per object, so its trailer can be far past the start of the section.
    const trailerAt = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).indexOf("trailer", startxref, "latin1")
    if (trailerAt < 0) throw new PdfError("malformed", "trailer not found")
    dict = latin1.decode(bytes.subarray(trailerAt, Math.min(bytes.length, trailerAt + 4096)))
  } else if (/^\d+\s+\d+\s+obj/.test(section)) {
    kind = "stream"
    dict = section.slice(0, section.indexOf("stream"))
  } else {
    throw new PdfError("malformed", "startxref does not point to a cross-reference section")
  }
  const size = /\/Size\s+(\d+)/.exec(dict)
  if (!size) throw new PdfError("malformed", "trailer without /Size")
  return { startxref, kind, size: Number(size[1]) }
}

function hexId(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16)))
    .toString("hex")
    .toUpperCase()
}

/** Metrics and WinAnsi encoding of a standard font (pdf-lib's enum and the embedder's are the same strings). */
function standardFont(name: StandardFonts) {
  return StandardFontEmbedder.for(name as unknown as Parameters<typeof StandardFontEmbedder.for>[0])
}

/**
 * Text the standard fonts can draw (WinAnsi): letters outside it lose their accents ("ł" → "l"), anything else
 * becomes "?". Italian names are entirely within WinAnsi.
 */
const STROKED: Record<string, string> = { Ł: "L", ł: "l", Đ: "D", đ: "d", Ħ: "H", ħ: "h", ı: "i", Ŀ: "L", ŀ: "l" }

export function winAnsi(text: string): string {
  const font = standardFont(StandardFonts.Helvetica)
  let out = ""
  for (const ch of text.normalize("NFC")) {
    const candidates = [ch, STROKED[ch] ?? ch.normalize("NFD").replace(/\p{M}/gu, ""), "?"]
    out += candidates.find((c) => c.length > 0 && canEncode(font, c)) ?? "?"
  }
  return out
}

function canEncode(font: ReturnType<typeof standardFont>, text: string) {
  try {
    font.encodeText(text)
    return true
  } catch {
    return false
  }
}

/** Throws when an existing certification signature forbids any change (DocMDP permission 1). */
function assertChangesAllowed(doc: PDFDocument) {
  const { context } = doc
  const perms = context.lookupMaybe(doc.catalog.get(PDFName.of("Perms")), PDFDict)
  const docMdp = perms ? context.lookupMaybe(perms.get(PDFName.of("DocMDP")), PDFDict) : undefined
  const references = docMdp ? context.lookupMaybe(docMdp.get(PDFName.of("Reference")), PDFArray) : undefined
  for (let i = 0; i < (references?.size() ?? 0); i++) {
    const ref = context.lookupMaybe(references?.get(i), PDFDict)
    const params = ref ? context.lookupMaybe(ref.get(PDFName.of("TransformParams")), PDFDict) : undefined
    const p = params ? context.lookupMaybe(params.get(PDFName.of("P")), PDFNumber) : undefined
    if (p?.asNumber() === 1)
      throw new PdfError("locked", "The document is certified and does not allow further signatures")
  }
}

/** The appearance stream drawing the signature box: a hairline frame and the text lines fitted to the box. */
function appearanceContent(width: number, height: number, appearance: SignatureAppearance) {
  const regular = standardFont(StandardFonts.Helvetica)
  const bold = standardFont(StandardFonts.HelveticaBold)
  const padding = Math.min(6, width * 0.05, height * 0.08)
  const lines = appearance.lines.map((l) => ({ ...l, text: winAnsi(l.text) })).filter((l) => l.text.trim() !== "")
  const innerW = width - 2 * padding
  const innerH = height - 2 * padding
  const lineGap = 1.25
  // Largest size that fits the height, then shrink until the widest line fits too; bold first lines are larger.
  const weights = lines.map((l) => (l.bold ? 1.25 : 1))
  let size = Math.min(14, innerH / weights.reduce((sum, w) => sum + w * lineGap, 0))
  for (const [i, line] of lines.entries()) {
    const font = line.bold ? bold : regular
    const w = font.widthOfTextAtSize(line.text, size * weights[i])
    if (w > innerW) size = Math.min(size, (innerW / w) * size)
  }
  size = Math.max(size, 3)
  const ops: string[] = [
    "q",
    "0.75 0.78 0.82 RG 0.5 w",
    `0.25 0.25 ${(width - 0.5).toFixed(2)} ${(height - 0.5).toFixed(2)} re S`,
  ]
  const total = lines.reduce((sum, _l, i) => sum + weights[i] * size * lineGap, 0)
  let y = height - padding - (innerH - total) / 2
  for (const [i, line] of lines.entries()) {
    const fontSize = size * weights[i]
    y -= fontSize * lineGap
    const font = line.bold ? bold : regular
    const encoded = font.encodeText(line.text).toString()
    const color = line.muted ? "0.38 0.42 0.48 rg" : "0.07 0.09 0.12 rg"
    ops.push(
      `BT ${color} /${line.bold ? "F2" : "F1"} ${fontSize.toFixed(2)} Tf ${padding.toFixed(2)} ${(y + fontSize * 0.25).toFixed(2)} Td ${encoded} Tj ET`
    )
  }
  ops.push("Q")
  return ops.join("\n")
}

const ROTATION_MATRIX: Record<number, string> = {
  0: "1 0 0 1 0 0",
  90: "0 1 -1 0 0 0",
  180: "-1 0 0 -1 0 0",
  270: "0 -1 1 0 0 0",
}

/**
 * Appends an incremental update with a signature field, its visible widget and a signature dictionary whose /Contents
 * is a zero-filled placeholder. Earlier revisions, and the signatures over them, stay byte-for-byte unchanged.
 */
export async function addSignaturePlaceholder(input: Uint8Array, options: PlaceholderOptions): Promise<Placeholder> {
  let doc: PDFDocument
  try {
    doc = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: false })
  } catch (error) {
    if (error instanceof Error && error.name === "EncryptedPDFError")
      throw new PdfError("encrypted", "Encrypted PDFs cannot be signed")
    throw new PdfError("malformed", `Cannot read the PDF: ${error instanceof Error ? error.message : error}`)
  }
  if (doc.isEncrypted) throw new PdfError("encrypted", "Encrypted PDFs cannot be signed")
  assertChangesAllowed(doc)
  const tail = readTail(input)
  const { context } = doc
  const pages = doc.getPages()
  const page = pages[options.placement.page]
  if (!page) throw new PdfError("page_out_of_range", `The document has ${pages.length} pages`)
  const markPages = (options.marks ?? []).map((m) => pages[m.page])
  if (markPages.some((p) => !p)) throw new PdfError("page_out_of_range", `The document has ${pages.length} pages`)

  let next = Math.max(context.largestObjectNumber + 1, tail.size)
  const allocate = () => PDFRef.of(next++, 0)
  /** Objects of this update, by object number. */
  const written = new Map<number, { ref: PDFRef; bytes: Uint8Array }>()
  const write = (ref: PDFRef, body: Uint8Array) => written.set(ref.objectNumber, { ref, bytes: body })
  const writeObject = (ref: PDFRef, obj: PDFObject) => write(ref, serialize(obj))

  const sigRef = allocate()
  const widgetRef = allocate()
  const apRef = allocate()
  const fontRef = allocate()
  const boldRef = allocate()

  write(fontRef, ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"))
  write(boldRef, ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"))
  /** Draws one box: returns its rectangle in user space; the drawing is turned upright on rotated pages. */
  const drawBox = (target: PDFPage, placement: Placement, ref: PDFRef) => {
    const { rect, rotation, width, height } = rectOnPage(target, placement)
    const content = ascii(appearanceContent(width, height, options.appearance))
    write(
      ref,
      concat([
        ascii(
          `<< /Type /XObject /Subtype /Form /BBox [0 0 ${width.toFixed(2)} ${height.toFixed(2)}] /Matrix [${ROTATION_MATRIX[rotation]}] ` +
            `/Resources << /Font << /F1 ${fontRef} /F2 ${boldRef} >> >> /Length ${content.length} >>\nstream\n`
        ),
        content,
        ascii("\nendstream"),
      ])
    )
    return rect.map((n) => n.toFixed(2)).join(" ")
  }
  write(
    widgetRef,
    ascii(
      `<< /Type /Annot /Subtype /Widget /FT /Sig /T ${pdfTextString(options.fieldName)} /V ${sigRef} /F 132 ` +
        `/Rect [${drawBox(page, options.placement, apRef)}] /P ${page.ref} /AP << /N ${apRef} >> >>`
    )
  )
  /** The update's annotations by page, added to each page's /Annots once. */
  const newAnnots = new Map<PDFPage, PDFRef[]>([[page, [widgetRef]]])
  // Marks: read-only stamps with the same drawing. They are not fields, so viewers list one signature.
  for (const [i, mark] of (options.marks ?? []).entries()) {
    const target = markPages[i] as PDFPage
    const markRef = allocate()
    const markApRef = allocate()
    write(
      markRef,
      ascii(
        `<< /Type /Annot /Subtype /Stamp /F 196 /Rect [${drawBox(target, mark, markApRef)}] /P ${target.ref} ` +
          `/Contents ${pdfTextString(`Firmato digitalmente da ${options.signerName}`)} /AP << /N ${markApRef} >> >>`
      )
    )
    newAnnots.set(target, [...(newAnnots.get(target) ?? []), markRef])
  }

  // Each page's /Annots: modify the array object when indirect, else the page itself.
  for (const [target, refs] of newAnnots) {
    const annots = target.node.get(PDFName.of("Annots"))
    if (annots instanceof PDFRef) {
      const array = context.lookup(annots, PDFArray)
      for (const ref of refs) array.push(ref)
      writeObject(annots, array)
    } else {
      const array = annots instanceof PDFArray ? annots : context.obj([])
      for (const ref of refs) array.push(ref)
      target.node.set(PDFName.of("Annots"), array)
      writeObject(target.ref, target.node)
    }
  }

  // The AcroForm: /Fields gets the new field and /SigFlags 3 (signatures exist, append only).
  const catalogRef = context.trailerInfo.Root
  if (!(catalogRef instanceof PDFRef)) throw new PdfError("malformed", "Catalog is not an indirect object")
  const catalog = context.lookup(catalogRef, PDFDict)
  const acroFormEntry = catalog.get(PDFName.of("AcroForm"))
  let acroForm: PDFDict
  let acroFormRef: PDFRef | null = null
  if (acroFormEntry instanceof PDFRef) {
    acroFormRef = acroFormEntry
    acroForm = context.lookup(acroFormEntry, PDFDict)
  } else if (acroFormEntry instanceof PDFDict) {
    acroForm = acroFormEntry
  } else {
    acroFormRef = allocate()
    acroForm = context.obj({ Fields: [] })
    catalog.set(PDFName.of("AcroForm"), acroFormRef)
    writeObject(catalogRef, catalog)
  }
  const fieldsEntry = acroForm.get(PDFName.of("Fields"))
  if (fieldsEntry instanceof PDFRef) {
    const fields = context.lookup(fieldsEntry, PDFArray)
    fields.push(widgetRef)
    writeObject(fieldsEntry, fields)
  } else {
    const fields = fieldsEntry instanceof PDFArray ? fieldsEntry : context.obj([])
    fields.push(widgetRef)
    acroForm.set(PDFName.of("Fields"), fields)
  }
  acroForm.set(PDFName.of("SigFlags"), PDFNumber.of(3))
  if (acroFormRef) writeObject(acroFormRef, acroForm)
  else writeObject(catalogRef, catalog)

  // The signature dictionary, written by hand so the placeholders have fixed, known positions.
  const contentsHexLength = SIGNATURE_RESERVED_BYTES * 2
  const byteRangePlaceholder = `[0 ${"0".repeat(10)} ${"0".repeat(10)} ${"0".repeat(10)}]`
  const optional = [
    options.reason ? `/Reason ${pdfTextString(options.reason)}` : "",
    options.location ? `/Location ${pdfTextString(options.location)}` : "",
  ]
    .filter(Boolean)
    .join(" ")
  const sigHead =
    `<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /Name ${pdfTextString(options.signerName)} ` +
    `/M ${pdfString(pdfDate(options.signingTime))} ${optional} /Prop_Build << /App << /Name /PoliNetwork#20Admin >> >> ` +
    `/ByteRange `
  const sigBody = `${sigHead}${byteRangePlaceholder} /Contents <${"0".repeat(contentsHexLength)}> >>`
  write(sigRef, ascii(sigBody))

  // Assemble the update: objects, then the cross-reference section in the same kind as the previous one.
  const lastByte = input[input.length - 1]
  const chunks: Uint8Array[] = [ascii(lastByte === 0x0a || lastByte === 0x0d ? "" : "\n")]
  let offset = input.length + chunks[0].length
  const offsets = new Map<number, { offset: number; gen: number }>()
  const sorted = [...written.values()].sort((a, b) => a.ref.objectNumber - b.ref.objectNumber)
  let sigObjectOffset = -1
  for (const { ref, bytes } of sorted) {
    offsets.set(ref.objectNumber, { offset, gen: ref.generationNumber })
    if (ref === sigRef) sigObjectOffset = offset
    const head = ascii(`${ref.objectNumber} ${ref.generationNumber} obj\n`)
    const foot = ascii("\nendobj\n")
    chunks.push(head, bytes, foot)
    offset += head.length + bytes.length + foot.length
  }

  const trailerInfo = context.trailerInfo
  const rootEntry = `/Root ${catalogRef}`
  const infoEntry = trailerInfo.Info instanceof PDFRef ? ` /Info ${trailerInfo.Info}` : ""
  const firstId = idOf(trailerInfo.ID) ?? hexId()
  const idEntry = ` /ID [<${firstId}> <${hexId()}>]`
  const xrefOffset = offset
  if (tail.kind === "table") {
    let table = "xref\n"
    for (const run of runs([...offsets.keys()])) {
      table += `${run[0]} ${run.length}\n`
      for (const n of run) {
        const entry = offsets.get(n)
        if (!entry) throw new Error("missing xref entry")
        table += `${String(entry.offset).padStart(10, "0")} ${String(entry.gen).padStart(5, "0")} n\r\n`
      }
    }
    table += `trailer\n<< /Size ${next} ${rootEntry}${infoEntry}${idEntry} /Prev ${tail.startxref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    chunks.push(ascii(table))
  } else {
    const xrefRef = allocate()
    offsets.set(xrefRef.objectNumber, { offset: xrefOffset, gen: 0 })
    const numbers = [...offsets.keys()].sort((a, b) => a - b)
    const index: number[] = []
    const data = new Uint8Array(numbers.length * 7)
    let pos = 0
    for (const run of runs(numbers)) {
      index.push(run[0], run.length)
      for (const n of run) {
        const entry = offsets.get(n)
        if (!entry) throw new Error("missing xref entry")
        data[pos] = 1
        new DataView(data.buffer).setUint32(pos + 1, entry.offset)
        new DataView(data.buffer).setUint16(pos + 5, entry.gen)
        pos += 7
      }
    }
    chunks.push(
      ascii(
        `${xrefRef.objectNumber} 0 obj\n<< /Type /XRef /Size ${next} /Index [${index.join(" ")}] /W [1 4 2] ` +
          `${rootEntry}${infoEntry}${idEntry} /Prev ${tail.startxref} /Length ${data.length} >>\nstream\n`
      ),
      data,
      ascii(`\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF\n`)
    )
  }

  const pdf = concat([input, ...chunks])
  if (sigObjectOffset < 0) throw new Error("signature object not written")
  const sigHeadAt = sigObjectOffset + ascii(`${sigRef.objectNumber} 0 obj\n`).length
  const byteRangeAt = sigHeadAt + ascii(sigHead).length
  const contentsAt = byteRangeAt + byteRangePlaceholder.length + " /Contents ".length
  if (pdf[contentsAt] !== 0x3c) throw new Error("placeholder offset mismatch")
  const a = contentsAt
  const b = contentsAt + contentsHexLength + 2
  const byteRange: Placeholder["byteRange"] = [0, a, b, pdf.length - b]
  const text = `[0 ${a} ${b} ${byteRange[3]}`
  const filled = `${text}${" ".repeat(byteRangePlaceholder.length - text.length - 1)}]`
  if (filled.length !== byteRangePlaceholder.length) throw new Error("ByteRange does not fit its placeholder")
  pdf.set(ascii(filled), byteRangeAt)
  return { pdf, byteRange, contentsOffset: contentsAt + 1, contentsHexLength }
}

/** The bytes a signature covers. */
export function signedBytes(pdf: Uint8Array, byteRange: readonly number[]): Uint8Array {
  const [a, b, c, d] = byteRange
  return concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)])
}

/** Writes the DER-encoded CMS into the placeholder. */
export function embedSignature(placeholder: Placeholder, cms: Uint8Array): Uint8Array {
  const hex = Buffer.from(cms).toString("hex").toUpperCase()
  if (hex.length > placeholder.contentsHexLength)
    throw new Error(`Signature (${cms.length} bytes) exceeds the reserved space`)
  const pdf = placeholder.pdf.slice()
  pdf.set(ascii(hex.padEnd(placeholder.contentsHexLength, "0")), placeholder.contentsOffset)
  return pdf
}

function idOf(id: PDFObject | undefined): string | null {
  if (!(id instanceof PDFArray) || id.size() === 0) return null
  const first = id.get(0)
  if (first instanceof PDFHexString || first instanceof PDFString)
    return Buffer.from(first.asBytes()).toString("hex").toUpperCase()
  return null
}

/** Groups sorted numbers into runs of consecutive values. */
function runs(numbers: number[]): number[][] {
  const out: number[][] = []
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && last[last.length - 1] === n - 1) last.push(n)
    else out.push([n])
  }
  return out
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let pos = 0
  for (const p of parts) {
    out.set(p, pos)
    pos += p.length
  }
  return out
}
