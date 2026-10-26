import { PDFDocument } from "pdf-lib"
import { inspectPdf } from "@/esign/pdf/inspect"
import { fail } from "./model"

/** Detect actual content, then parse it. Image dimensions are bounded before raster decompression. */
export async function transferType(bytes: Uint8Array): Promise<string> {
  try {
    if (Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
      const pdf = await inspectPdf(bytes)
      if (!pdf.pages.length) fail("BAD_REQUEST", "The PDF has no pages")
      return "application/pdf"
    }
    const doc = await PDFDocument.create()
    if (
      bytes[0] === 0x89 &&
      Buffer.from(bytes.subarray(1, 8)).toString("hex") === "504e470d0a1a0a" &&
      bytes.length >= 33
    ) {
      const width = Buffer.from(bytes).readUInt32BE(16)
      const height = Buffer.from(bytes).readUInt32BE(20)
      if (!width || !height || width * height > 20_000_000) fail("BAD_REQUEST", "Image exceeds 20 megapixels")
      const idat: Buffer[] = []
      const buffer = Buffer.from(bytes)
      let position = 8
      while (position + 12 <= bytes.length) {
        const length = buffer.readUInt32BE(position)
        if (position + length + 12 > bytes.length) fail("BAD_REQUEST", "Truncated PNG chunk")
        if (buffer.toString("ascii", position + 4, position + 8) === "IDAT")
          idat.push(buffer.subarray(position + 8, position + 8 + length))
        position += length + 12
      }
      if (!idat.length) fail("BAD_REQUEST", "PNG has no image data")
      inflateSync(Buffer.concat(idat), { maxOutputLength: Math.min(160_000_000, width * height * 8 + height * 8) })
      await doc.embedPng(bytes)
      return "image/png"
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      const image = await doc.embedJpg(bytes)
      if (image.width * image.height > 20_000_000 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
        fail("BAD_REQUEST", "Invalid or oversized JPEG")
      return "image/jpeg"
    }
  } catch {
    fail("BAD_REQUEST", "Cannot read this PDF, JPEG or PNG")
  }
  fail("BAD_REQUEST", "Upload a PDF, JPEG or PNG by content")
}

import { inflateSync } from "node:zlib"
