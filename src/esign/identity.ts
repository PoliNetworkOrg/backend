import type { X509Certificate } from "node:crypto"

export type CertificateIdentity = {
  /** "Mario Rossi": given name and surname in title case, else the common name. */
  name: string
  /** Codice fiscale from the subject, when present: see fiscalCodeOf. */
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

// Six letters, birth year, month letter, day, municipality, check letter; digits may be replaced by letters (omocodia).
const FISCAL_CODE = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/

/**
 * The codice fiscale in a subject DN as Node prints it (one "key=value" per line). A CIE authentication certificate
 * has it in CN "<codice fiscale>/<NIS>", its serialNumber being the document number "IDCIT-…"; other Italian
 * certificates carry it in serialNumber "TINIT-…" (ETSI EN 319 412-1).
 */
export function fiscalCodeOf(dn: string): string | null {
  const serial = field(dn, "serialNumber")?.toUpperCase()
  const cn = field(dn, "CN")?.toUpperCase()
  for (const candidate of [serial?.startsWith("TINIT-") ? serial.slice(6) : null, cn?.split("/")[0]])
    if (candidate && FISCAL_CODE.test(candidate)) return candidate
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
  return {
    name: given && surname ? `${titleCase(given)} ${titleCase(surname)}` : titleCase(cn),
    fiscalCode: fiscalCodeOf(cert.subject),
    subject: cert.subject.split("\n").reverse().join(", "),
    issuer: field(cert.issuer, "CN") ?? cert.issuer,
  }
}
