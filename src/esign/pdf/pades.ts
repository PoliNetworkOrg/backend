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
  const coversWholeDocument = a === 0 && c + d === pdf.length && b < c
  const digest = sha256(signedBytes(pdf, byteRange))
  const intact = parsed.messageDigest !== null && Buffer.from(digest).equals(Buffer.from(parsed.messageDigest))
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
