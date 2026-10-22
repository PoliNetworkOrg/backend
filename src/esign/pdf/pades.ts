import { X509Certificate } from "node:crypto"
import {
  buildSignedData,
  dataToBeSigned,
  type ParsedSignature,
  parseSignedData,
  sha256,
  signedAttributes,
  verifyAttributesSignature,
} from "./cms"
import { read } from "./der"
import {
  addSignaturePlaceholder,
  embedSignature,
  type Placeholder,
  type PlaceholderOptions,
  signedBytes,
} from "./incremental"

export type PreparedSignature = {
  placeholder: Placeholder
  /** DER `SET OF Attribute` whose SHA-256 the card signs. */
  signedAttrs: Uint8Array
  /** SHA-256 of `signedAttrs`: what the agent signs. */
  toBeSigned: Uint8Array
  certificate: Uint8Array
}

export class SignatureError extends Error {
  constructor(
    readonly code: "certificate_invalid" | "signature_invalid" | "too_large",
    message: string
  ) {
    super(message)
    this.name = "SignatureError"
  }
}

/** Phase 1: adds the signature field and placeholder, and computes what the card must sign. */
export async function prepareSignature(
  pdf: Uint8Array,
  certificate: Uint8Array,
  options: PlaceholderOptions
): Promise<PreparedSignature> {
  let cert: X509Certificate
  try {
    cert = new X509Certificate(Buffer.from(certificate))
  } catch {
    throw new SignatureError("certificate_invalid", "The certificate cannot be read")
  }
  const now = options.signingTime.getTime()
  if (now < Date.parse(cert.validFrom) || now > Date.parse(cert.validTo))
    throw new SignatureError("certificate_invalid", "The certificate is expired or not yet valid")
  if (cert.publicKey.asymmetricKeyType !== "rsa")
    throw new SignatureError("certificate_invalid", "Only RSA certificates are supported")

  const placeholder = await addSignaturePlaceholder(pdf, options)
  const contentDigest = sha256(signedBytes(placeholder.pdf, placeholder.byteRange))
  const signedAttrs = signedAttributes(contentDigest, certificate)
  return { placeholder, signedAttrs, toBeSigned: dataToBeSigned(signedAttrs), certificate }
}

/** Phase 2: checks the card's signature and embeds the CMS. */
export function finalizeSignature(
  prepared: PreparedSignature,
  signature: Uint8Array,
  chain: Uint8Array[] = []
): Uint8Array {
  if (!verifyAttributesSignature(prepared.signedAttrs, signature, prepared.certificate))
    throw new SignatureError("signature_invalid", "The signature does not match the certificate and document")
  const cms = buildSignedData({ signedAttrs: prepared.signedAttrs, signature, certDer: prepared.certificate, chain })
  try {
    return embedSignature(prepared.placeholder, cms)
  } catch (error) {
    throw new SignatureError("too_large", error instanceof Error ? error.message : String(error))
  }
}

export type SignatureCheck = {
  /** The bytes covered by the signature hash to the signed message digest. */
  intact: boolean
  /** The signer's key signed the attributes. */
  verified: boolean
  /** The signature covers the whole file (no later changes). */
  coversWholeDocument: boolean
}

/** Cryptographic check of one PDF signature: integrity and signature, not the certificate's trust chain. */
export function checkSignature(
  pdf: Uint8Array,
  byteRange: readonly number[],
  contents: Uint8Array
): SignatureCheck & { parsed: ParsedSignature | null } {
  let parsed: ParsedSignature
  try {
    parsed = parseSignedData(read(contents).raw)
  } catch {
    return { intact: false, verified: false, coversWholeDocument: false, parsed: null }
  }
  const [a, b, c, d] = byteRange
  // The only bytes left out may be this signature's own /Contents value, delimiters included: a ByteRange that skips
  // anything else leaves those bytes unsigned.
  const gapStart = a + b
  const gapIsContents =
    byteRange.length === 4 &&
    byteRange.every((n) => Number.isSafeInteger(n) && n >= 0) &&
    a === 0 &&
    gapStart < c &&
    c + d <= pdf.length &&
    pdf[gapStart] === 0x3c &&
    pdf[c - 1] === 0x3e &&
    hexEquals(pdf.subarray(gapStart + 1, c - 1), contents)
  const coversWholeDocument = gapIsContents && c + d === pdf.length
  const digest = sha256(signedBytes(pdf, byteRange))
  const intact =
    gapIsContents && parsed.messageDigest !== null && Buffer.from(digest).equals(Buffer.from(parsed.messageDigest))
  let verified = false
  if (parsed.signedAttrs && parsed.certificate) {
    try {
      verified = verifyAttributesSignature(parsed.signedAttrs, parsed.signature, parsed.certificate.raw)
    } catch {
      verified = false
    }
  }
  return { intact, verified, coversWholeDocument, parsed }
}

/** Whether `hex` (ASCII hex digits, possibly with whitespace) encodes `bytes`, zero-padded to its length. */
function hexEquals(hex: Uint8Array, bytes: Uint8Array): boolean {
  const text = Buffer.from(hex).toString("latin1").replace(/\s+/g, "")
  if (!/^[0-9A-Fa-f]*$/.test(text) || text.length % 2 !== 0) return false
  const decoded = Buffer.from(text, "hex")
  if (decoded.length < bytes.length) return false
  if (!decoded.subarray(0, bytes.length).equals(Buffer.from(bytes))) return false
  return decoded.subarray(bytes.length).every((v) => v === 0)
}
