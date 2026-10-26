import type { X509Certificate } from "node:crypto"
import { EsignError } from "./errors"
import { CMS_OID, parseSignedData, sha256, verifyAttributesSignature } from "./pdf/cms"
import { children, oidString, read } from "./pdf/der"
import { assertSignatureOnlyUpdate } from "./pdf/diff"
import { PdfError } from "./pdf/incremental"
import { inspectPdf } from "./pdf/inspect"

export type SignedUpload = { pdf: Uint8Array; certificate: X509Certificate; envelope: boolean }

/** Cryptographic inspection shared by People previews and eSign's final manual-upload validation. */
export async function inspectSignedUpload(bytes: Uint8Array): Promise<SignedUpload> {
  if (Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-") {
    const pdf = await inspectPdf(bytes)
    const signature = pdf.signatures.at(-1)
    if (!signature?.intact || !signature.verified || !signature.coversWholeDocument || !pdf.lastCertificate)
      throw new EsignError("signature_invalid", "The file does not have a valid signature covering the entire PDF")
    return { pdf: bytes, certificate: pdf.lastCertificate, envelope: false }
  }
  try {
    const outer = read(bytes)
    if (outer.raw.length !== bytes.length) throw new Error("Trailing data")
    const signedData = children(children(children(outer)[1])[0])
    const encapsulated = children(signedData[2])
    if (oidString(encapsulated[0]) !== CMS_OID.data || encapsulated.length !== 2)
      throw new Error("Missing encapsulated PDF")
    const content = children(encapsulated[1])
    if (content.length !== 1 || content[0].tag !== 0x04) throw new Error("Expected DER octet string")
    const pdf = content[0].value
    if (Buffer.from(pdf.subarray(0, 5)).toString() !== "%PDF-") throw new Error("Envelope does not contain a PDF")
    const cms = parseSignedData(bytes)
    if (
      !cms.certificate ||
      !cms.signedAttrs ||
      !cms.messageDigest ||
      cms.digestAlgorithm !== CMS_OID.sha256 ||
      ![CMS_OID.rsaEncryption, CMS_OID.sha256WithRSA].includes(cms.signatureAlgorithm as typeof CMS_OID.rsaEncryption)
    )
      throw new Error("Unsupported CMS signature")
    if (
      !Buffer.from(cms.messageDigest).equals(Buffer.from(sha256(pdf))) ||
      !verifyAttributesSignature(cms.signedAttrs, cms.signature, new Uint8Array(cms.certificate.raw))
    )
      throw new Error("CMS signature mismatch")
    return { pdf, certificate: cms.certificate, envelope: true }
  } catch (error) {
    throw new EsignError("signature_invalid", error instanceof Error ? error.message : "Invalid CMS envelope")
  }
}

export async function validateUploadedRevision(
  original: Uint8Array,
  bytes: Uint8Array,
  allowEnvelope: boolean
): Promise<SignedUpload> {
  const isPdf = Buffer.from(bytes.subarray(0, 5)).toString() === "%PDF-"
  if (
    isPdf &&
    (bytes.length <= original.length || !Buffer.from(bytes.subarray(0, original.length)).equals(Buffer.from(original)))
  )
    throw new EsignError("pdf_invalid", "The file is not the issued PDF with a signature added")
  const signed = await inspectSignedUpload(bytes)
  if (signed.envelope) {
    if (!allowEnvelope || !Buffer.from(signed.pdf).equals(Buffer.from(original)))
      throw new EsignError("pdf_invalid", "The signed envelope does not contain this issued receipt")
    return signed
  }
  if (bytes.length <= original.length || !Buffer.from(bytes.subarray(0, original.length)).equals(Buffer.from(original)))
    throw new EsignError("pdf_invalid", "The file is not the issued PDF with a signature added")
  const [before, after] = await Promise.all([inspectPdf(original), inspectPdf(bytes)])
  if (after.signatures.length !== before.signatures.length + 1 || !after.lastSignature)
    throw new EsignError("pdf_invalid", "The file must add exactly one signature")
  try {
    await assertSignatureOnlyUpdate(original, bytes, after.lastSignature)
  } catch (error) {
    if (error instanceof PdfError) throw new EsignError("pdf_invalid", error.message)
    throw error
  }
  return signed
}
