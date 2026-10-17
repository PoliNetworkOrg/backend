import { X509Certificate } from "node:crypto"
import { CIE_CA_PEM } from "./cie-ca"

const parsePem = (pem: string) =>
  [...pem.matchAll(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g)].map(
    (m) => new X509Certificate(m[0])
  )

const CIE_CAS = parsePem(CIE_CA_PEM)
const ROOTS = CIE_CAS.filter((c) => c.subject === c.issuer)
/**
 * The issuing CAs are pinned trust anchors, as published by the Ministry. SUBCA003 (2024) is signed by a re-keyed
 * national root that the Ministry does not publish (its authority key identifier differs from the 2016 root's), so
 * its path to a root cannot be checked; pinning the issuing CAs themselves keeps it usable without weakening the leaf
 * check.
 */
export const CIE_ISSUING_CAS = CIE_CAS.filter((c) => c.subject !== c.issuer)

function signedBy(cert: X509Certificate, issuer: X509Certificate) {
  try {
    return cert.checkIssued(issuer) && cert.verify(issuer.publicKey)
  } catch {
    return false
  }
}

const valid = (c: X509Certificate, now: Date) => now >= new Date(c.validFrom) && now <= new Date(c.validTo)

/**
 * Whether the certificate was issued by one of the Ministero dell'Interno's CIE issuing CAs, and the chain to embed in
 * the signature (issuing CA, then the root when it verifies). Revocation is checked separately (`revocation.ts`).
 */
export function cieChain(
  cert: X509Certificate,
  now = new Date()
): { trusted: boolean; chain: Uint8Array[]; issuer: X509Certificate | null } {
  const issuer = CIE_ISSUING_CAS.find((ca) => signedBy(cert, ca)) ?? null
  if (!issuer || !valid(issuer, now)) return { trusted: false, chain: [], issuer: null }
  const root = ROOTS.find((r) => signedBy(issuer, r) && valid(r, now))
  const chain = [new Uint8Array(issuer.raw), ...(root ? [new Uint8Array(root.raw)] : [])]
  return { trusted: true, chain, issuer }
}
