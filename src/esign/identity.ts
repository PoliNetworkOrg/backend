import type { X509Certificate } from "node:crypto"

export type CertificateIdentity = {
  /** "Mario Rossi": given name and surname in title case, else the common name. */
  name: string
  /** Codice fiscale from serialNumber "TINIT-…" (ETSI EN 319 412-1), when present. */
  fiscalCode: string | null
  subject: string
  issuer: string
}

function field(dn: string, key: string): string | null {
  for (const line of dn.split("\n")) {
    const at = line.indexOf("=")
    if (at > 0 && line.slice(0, at) === key) return line.slice(at + 1)
  }
  return null
}

export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/(^|[\s'’-])(\p{L})/gu, (_m, sep: string, letter: string) => sep + letter.toUpperCase())
}

/** The signer's identity in a CIE-style certificate. */
export function identityOf(cert: X509Certificate): CertificateIdentity {
  const given = field(cert.subject, "GN")
  const surname = field(cert.subject, "SN")
  const cn = field(cert.subject, "CN") ?? cert.subject
  const serial = field(cert.subject, "serialNumber")
  return {
    name: given && surname ? `${titleCase(given)} ${titleCase(surname)}` : titleCase(cn),
    fiscalCode: serial?.startsWith("TINIT-") ? serial.slice(6).toUpperCase() : null,
    subject: cert.subject.split("\n").reverse().join(", "),
    issuer: field(cert.issuer, "CN") ?? cert.issuer,
  }
}
