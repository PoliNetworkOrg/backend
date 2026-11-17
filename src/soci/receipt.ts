import { inflateSync } from "node:zlib"
import { TRPCError } from "@trpc/server"
import { PDFDocument } from "pdf-lib"
import { inspectPdf } from "@/esign/pdf/inspect"
import { MAX_RECEIPT_BYTES } from "./fees"

const refuse = (message: string): never => {
  throw new TRPCError({ code: "BAD_REQUEST", message })
}

/**
 * The receipt's type, from its content rather than its name: a PDF with pages, a PNG or a JPEG. Image dimensions are
 * bounded before decompression. As the removed `people_files` did (`git show f70dae3^:src/people/files.ts`).
 */
export async function receiptType(bytes: Uint8Array): Promise<"application/pdf" | "image/png" | "image/jpeg"> {
  if (bytes.length === 0) refuse("The file is empty.")
  if (bytes.length > MAX_RECEIPT_BYTES) refuse("The file is larger than 10 MB.")
  let type: "application/pdf" | "image/png" | "image/jpeg" | null = null
  let problem: string | null = null
  try {
    if (Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
      const pdf = await inspectPdf(bytes)
      if (!pdf.pages.length) problem = "The PDF has no pages."
      else type = "application/pdf"
    } else if (
      bytes[0] === 0x89 &&
      Buffer.from(bytes.subarray(1, 8)).toString("hex") === "504e470d0a1a0a" &&
      bytes.length >= 33
    ) {
      const buffer = Buffer.from(bytes)
      const width = buffer.readUInt32BE(16)
      const height = buffer.readUInt32BE(20)
      if (!width || !height || width * height > 20_000_000) problem = "The image is larger than 20 megapixels."
      else {
        const idat: Buffer[] = []
        let position = 8
        while (position + 12 <= bytes.length) {
          const length = buffer.readUInt32BE(position)
          if (position + length + 12 > bytes.length) {
            problem = "The PNG is truncated."
            break
          }
          if (buffer.toString("ascii", position + 4, position + 8) === "IDAT")
            idat.push(buffer.subarray(position + 8, position + 8 + length))
          position += length + 12
        }
        if (!problem && !idat.length) problem = "The PNG has no image data."
        if (!problem) {
          inflateSync(Buffer.concat(idat), { maxOutputLength: Math.min(160_000_000, width * height * 8 + height * 8) })
          await (await PDFDocument.create()).embedPng(bytes)
          type = "image/png"
        }
      }
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      const image = await (await PDFDocument.create()).embedJpg(bytes)
      if (image.width * image.height > 20_000_000 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9)
        problem = "The JPEG is invalid or larger than 20 megapixels."
      else type = "image/jpeg"
    } else problem = "Upload a PDF, JPEG or PNG."
  } catch {
    problem = "This PDF, JPEG or PNG can't be read."
  }
  return type ?? refuse(problem ?? "Upload a PDF, JPEG or PNG.")
}
