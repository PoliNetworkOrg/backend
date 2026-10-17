import { createHash, verify, X509Certificate } from "node:crypto"
import { children, nullValue, octetString, oid, oidString, read, sequence, type Tlv } from "../pdf/der"

export type RevocationStatus = "good" | "revoked" | "unknown"

export type RevocationResult = {
  status: RevocationStatus
  /** Why the status is unknown, or when the certificate was revoked. */
  detail: string | null
  checkedAt: string
}

const SHA1 = "1.3.14.3.2.26"
const OCSP_BASIC = "1.3.6.1.5.5.7.48.1.1"
const OCSP_SIGNING = "1.3.6.1.5.5.7.3.9"
const SIGNATURE_HASHES: Record<string, string> = {
  "1.2.840.113549.1.1.5": "sha1",
  "1.2.840.113549.1.1.11": "sha256",
  "1.2.840.113549.1.1.12": "sha384",
  "1.2.840.113549.1.1.13": "sha512",
}
/** Clock skew tolerated on thisUpdate/nextUpdate. */
const SKEW_MS = 5 * 60 * 1000
/** A response produced longer ago than this is not fresh enough to rely on. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const sha1 = (data: Uint8Array) => new Uint8Array(createHash("sha1").update(data).digest())

function tbsFields(certDer: Uint8Array): Tlv[] {
  const tbs = children(children(read(certDer))[0])
  return tbs[0].tag === 0xa0 ? tbs.slice(1) : tbs
}

/** The OCSP CertID of `cert` issued by `issuer` (SHA-1, as responders expect). */
function certId(cert: X509Certificate, issuer: X509Certificate): Uint8Array {
  const leaf = tbsFields(new Uint8Array(cert.raw))
  const ca = tbsFields(new Uint8Array(issuer.raw))
  const issuerName = ca[4].raw
  const [, publicKeyBits] = children(ca[5])
  return sequence(
    sequence(oid(SHA1), nullValue()),
    octetString(sha1(issuerName)),
    // The key hash covers the BIT STRING contents without its unused-bits byte.
    octetString(sha1(publicKeyBits.value.subarray(1))),
    leaf[0].raw
  )
}

function generalizedTime(element: Tlv | undefined): Date | null {
  if (!element || element.tag !== 0x18) return null
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(new TextDecoder().decode(element.value))
  if (!m) return null
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]))
}

function equal(a: Uint8Array, b: Uint8Array) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/** The OCSP responder named in the certificate's Authority Information Access. */
export function ocspUrl(cert: X509Certificate): string | null {
  return /OCSP - URI:(\S+)/.exec(cert.infoAccess ?? "")?.[1] ?? null
}

export function buildOcspRequest(cert: X509Certificate, issuer: X509Certificate): Uint8Array {
  return sequence(sequence(sequence(sequence(certId(cert, issuer)))))
}

/**
 * Reads an OCSP response for `cert`: checks the responder's signature (the issuer, or a certificate it delegated with
 * id-kp-OCSPSigning), the CertID and the freshness, then returns the certificate's status.
 */
export function parseOcspResponse(
  der: Uint8Array,
  cert: X509Certificate,
  issuer: X509Certificate,
  now: Date
): RevocationResult {
  const unknown = (detail: string): RevocationResult => ({ status: "unknown", detail, checkedAt: now.toISOString() })
  const [status, responseBytes] = children(read(der))
  if (status.value[0] !== 0 || !responseBytes) return unknown(`responder status ${status.value[0]}`)
  const [type, response] = children(children(responseBytes)[0])
  if (oidString(type) !== OCSP_BASIC) return unknown("not a basic OCSP response")
  const basic = children(read(response.value))
  const [tbs, signatureAlgorithm, signatureBits] = basic
  const certsField = basic.find((e) => e.tag === 0xa0)
  const hash = SIGNATURE_HASHES[oidString(children(signatureAlgorithm)[0])]
  if (!hash) return unknown("unsupported signature algorithm")
  const signature = signatureBits.value.subarray(1)

  const candidates = [issuer]
  if (certsField)
    for (const c of children(children(certsField)[0])) {
      const delegated = new X509Certificate(Buffer.from(c.raw))
      const authorized =
        delegated.checkIssued(issuer) &&
        delegated.verify(issuer.publicKey) &&
        (delegated.keyUsage ?? []).includes(OCSP_SIGNING) &&
        now >= new Date(delegated.validFrom) &&
        now <= new Date(delegated.validTo)
      if (authorized) candidates.push(delegated)
    }
  if (!candidates.some((signer) => verify(hash, tbs.raw, signer.publicKey, signature)))
    return unknown("the response signature does not verify")

  const data = children(tbs)
  const fields = data[0].tag === 0xa0 ? data.slice(1) : data
  const producedAt = generalizedTime(fields[1])
  const responses = children(fields[2])
  const expected = certId(cert, issuer)
  const expectedSerial = children(read(expected))[3].raw
  for (const single of responses) {
    const [id, certStatus, thisUpdateTlv, ...rest] = children(single)
    if (!equal(children(id)[3].raw, expectedSerial) || !equal(id.raw, expected)) continue
    const thisUpdate = generalizedTime(thisUpdateTlv)
    const nextUpdateTag = rest.find((e) => e.tag === 0xa0)
    const nextUpdate = nextUpdateTag ? generalizedTime(children(nextUpdateTag)[0]) : null
    if (!thisUpdate) return unknown("malformed response time")
    if (thisUpdate.getTime() > now.getTime() + SKEW_MS) return unknown("response from the future")
    if (nextUpdate && nextUpdate.getTime() < now.getTime() - SKEW_MS) return unknown("stale response")
    if (producedAt && now.getTime() - producedAt.getTime() > MAX_AGE_MS) return unknown("stale response")
    if (certStatus.tag === 0x80) return { status: "good", detail: null, checkedAt: now.toISOString() }
    if (certStatus.tag === 0xa1) {
      const revokedAt = generalizedTime(children(certStatus)[0])
      return { status: "revoked", detail: revokedAt?.toISOString() ?? null, checkedAt: now.toISOString() }
    }
    return unknown("the responder doesn't know the certificate")
  }
  return unknown("no status for this certificate")
}

/** Asks the certificate's OCSP responder whether it is revoked. Network and format failures give "unknown". */
export async function checkRevocation(
  cert: X509Certificate,
  issuer: X509Certificate,
  options: { now: Date; fetch?: typeof fetch; timeoutMs?: number; defaultUrl?: string }
): Promise<RevocationResult> {
  const url = ocspUrl(cert) ?? options.defaultUrl
  if (!url) return { status: "unknown", detail: "no OCSP responder", checkedAt: options.now.toISOString() }
  try {
    const response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "content-type": "application/ocsp-request", accept: "application/ocsp-response" },
      body: Buffer.from(buildOcspRequest(cert, issuer)),
      signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
    })
    if (!response.ok)
      return { status: "unknown", detail: `HTTP ${response.status}`, checkedAt: options.now.toISOString() }
    const body = new Uint8Array(await response.arrayBuffer())
    if (body.length > 64 * 1024)
      return { status: "unknown", detail: "response too large", checkedAt: options.now.toISOString() }
    return parseOcspResponse(body, cert, issuer, options.now)
  } catch (error) {
    return {
      status: "unknown",
      detail: error instanceof Error ? error.message : String(error),
      checkedAt: options.now.toISOString(),
    }
  }
}
