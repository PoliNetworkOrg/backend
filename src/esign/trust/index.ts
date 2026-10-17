import { X509Certificate } from "node:crypto"
import { CIE_CA_PEM } from "./cie-ca"

const parsePem = (pem: string) =>
  [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map(
    (m) => new X509Certificate(m[0])
  )

const CIE_CAS = parsePem(CIE_CA_PEM)
const ROOT = CIE_CAS.find((c) => c.subject === c.issuer)

/** The issuing CA a certificate was signed by, among `cas`, or null. */
function issuerOf(cert: X509Certificate, cas: X509Certificate[]) {
  return cas.find((ca) => cert.checkIssued(ca) && cert.verify(ca.publicKey)) ?? null
}

/**
 * Whether the certificate was issued by a CIE sub-CA of the Ministero dell'Interno, and the chain to embed in the
 * signature (sub-CA, root). Revocation is not checked here.
 */
export function cieChain(cert: X509Certificate, now = new Date()): { trusted: boolean; chain: Uint8Array[] } {
  if (!ROOT) return { trusted: false, chain: [] }
  const intermediate = issuerOf(
    cert,
    CIE_CAS.filter((c) => c !== ROOT)
  )
  if (!intermediate || !issuerOf(intermediate, [ROOT])) return { trusted: false, chain: [] }
  const valid = (c: X509Certificate) => now >= new Date(c.validFrom) && now <= new Date(c.validTo)
  if (!valid(intermediate) || !valid(ROOT)) return { trusted: false, chain: [] }
  return { trusted: true, chain: [new Uint8Array(intermediate.raw), new Uint8Array(ROOT.raw)] }
}
