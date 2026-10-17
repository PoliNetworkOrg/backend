import { createHash, verify, X509Certificate } from "node:crypto"
import {
  children,
  contextTag,
  integer,
  issuerAndSerial,
  nullValue,
  octetString,
  oid,
  oidString,
  read,
  sequence,
  setOf,
  type Tlv,
} from "./der"

const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  sha256: "2.16.840.1.101.3.4.2.1",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
} as const

const sha256 = (data: Uint8Array) => new Uint8Array(createHash("sha256").update(data).digest())
const algorithm = (id: string) => sequence(oid(id), nullValue())
const attribute = (type: string, value: Uint8Array) => sequence(oid(type), setOf(value))

/**
 * The CAdES signed attributes for PAdES baseline B-B (ETSI EN 319 142-1 §5.3): content-type, message-digest and
 * signing-certificate-v2. No signing-time: PAdES carries the time in the signature dictionary's /M.
 * Returns the DER `SET OF Attribute` that is signed; inside SignerInfo it appears with the tag `[0]` instead.
 */
export function signedAttributes(contentDigest: Uint8Array, certDer: Uint8Array): Uint8Array {
  const { issuer, serial } = issuerAndSerial(certDer)
  // ESSCertIDv2 with the default hash algorithm (SHA-256) omitted; issuerSerial: GeneralNames [directoryName [4]].
  const essCertId = sequence(octetString(sha256(certDer)), sequence(sequence(contextTag(4, issuer)), serial))
  const signingCertificateV2 = sequence(sequence(essCertId))
  return setOf(
    attribute(OID.contentType, oid(OID.data)),
    attribute(OID.messageDigest, octetString(contentDigest)),
    attribute(OID.signingCertificateV2, signingCertificateV2)
  )
}

/** What the card signs: SHA-256 of the DER signed attributes. */
export function dataToBeSigned(signedAttrs: Uint8Array): Uint8Array {
  return sha256(signedAttrs)
}

/** Whether `signature` is a valid RSA PKCS#1 v1.5 SHA-256 signature of `signedAttrs` by the certificate's key. */
export function verifyAttributesSignature(signedAttrs: Uint8Array, signature: Uint8Array, certDer: Uint8Array) {
  const { publicKey } = new X509Certificate(Buffer.from(certDer))
  return verify("sha256", signedAttrs, publicKey, signature)
}

/** The ContentInfo with a detached CMS SignedData (CAdES-BES) over the signed attributes. */
export function buildSignedData(input: {
  signedAttrs: Uint8Array
  signature: Uint8Array
  certDer: Uint8Array
  /** Issuer certificates to include after the signer's. */
  chain?: Uint8Array[]
}): Uint8Array {
  const { issuer, serial } = issuerAndSerial(input.certDer)
  // SignerInfo.signedAttrs is `[0] IMPLICIT SET OF Attribute`: same content, tag 0xA0 instead of 0x31.
  const attrsContent = read(input.signedAttrs).value
  const signerInfo = sequence(
    integer(1),
    sequence(issuer, serial),
    algorithm(OID.sha256),
    contextTag(0, attrsContent),
    algorithm(OID.rsaEncryption),
    octetString(input.signature)
  )
  const signedData = sequence(
    integer(1),
    setOf(algorithm(OID.sha256)),
    sequence(oid(OID.data)),
    contextTag(0, input.certDer, ...(input.chain ?? [])),
    setOf(signerInfo)
  )
  return sequence(oid(OID.signedData), contextTag(0, signedData))
}

export type ParsedSignature = {
  /** The signer's certificate, when the CMS carries it. */
  certificate: X509Certificate | null
  /** The certificates in the CMS, signer's first when found. */
  certificates: Uint8Array[]
  signedAttrs: Uint8Array | null
  messageDigest: Uint8Array | null
  signingTime: Date | null
  signature: Uint8Array
  digestAlgorithm: string
  signatureAlgorithm: string
}

/** Reads the parts of a CMS SignedData needed to verify and describe a PDF signature. */
export function parseSignedData(der: Uint8Array): ParsedSignature {
  const contentInfo = children(read(der))
  if (oidString(contentInfo[0]) !== OID.signedData) throw new Error("Not a CMS SignedData")
  const signedData = children(children(contentInfo[1])[0])
  let i = 3
  const certificates: Uint8Array[] = []
  if (signedData[i]?.tag === 0xa0) {
    for (const cert of children(signedData[i])) if (cert.tag === 0x30) certificates.push(cert.raw)
    i++
  }
  if (signedData[i]?.tag === 0xa1) i++
  const signerInfos = children(signedData[i])
  if (signerInfos.length !== 1) throw new Error("Expected exactly one signer")
  const si = children(signerInfos[0])
  const sid = si[1]
  const digestAlgorithm = oidString(children(si[2])[0])
  let j = 3
  let signedAttrs: Uint8Array | null = null
  let messageDigest: Uint8Array | null = null
  let signingTime: Date | null = null
  if (si[j].tag === 0xa0) {
    // Re-tag as SET OF for hashing (RFC 5652 §5.4).
    signedAttrs = new Uint8Array(si[j].raw)
    signedAttrs[0] = 0x31
    for (const attr of children(si[j])) {
      const [type, values] = children(attr)
      const value = children(values)[0]
      if (oidString(type) === OID.messageDigest) messageDigest = value.value
      if (oidString(type) === OID.signingTime) signingTime = parseTime(value)
    }
    j++
  }
  const signatureAlgorithm = oidString(children(si[j])[0])
  const signature = si[j + 1].value

  let certificate: X509Certificate | null = null
  const ordered = [...certificates]
  if (sid.tag === 0x30) {
    const [sidIssuer, sidSerial] = children(sid)
    const index = certificates.findIndex((c) => {
      const ids = issuerAndSerial(c)
      return equal(ids.issuer, sidIssuer.raw) && equal(ids.serial, sidSerial.raw)
    })
    if (index >= 0) {
      certificate = new X509Certificate(Buffer.from(certificates[index]))
      ordered.unshift(...ordered.splice(index, 1))
    }
  }
  return {
    certificate,
    certificates: ordered,
    signedAttrs,
    messageDigest,
    signingTime,
    signature,
    digestAlgorithm,
    signatureAlgorithm,
  }
}

function parseTime(value: Tlv): Date | null {
  const text = new TextDecoder().decode(value.value)
  const m = /^(\d{2,4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text)
  if (!m) return null
  let year = Number(m[1])
  if (m[1].length === 2) year += year < 50 ? 2000 : 1900
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)))
}

function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

export const CMS_OID = OID
export { sha256 }
