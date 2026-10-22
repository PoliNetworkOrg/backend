import "reflect-metadata"
import { constants, createPrivateKey, privateEncrypt, webcrypto } from "node:crypto"
import * as x509 from "@peculiar/x509"
import { PDFDocument, StandardFonts } from "pdf-lib"

x509.cryptoProvider.set(webcrypto as unknown as Crypto)

const alg = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
}

export type TestSigner = { cert: Uint8Array; key: webcrypto.CryptoKey; name: string; fiscalCode: string }

// Fixed, so the certificates also cover the frozen clock of the service tests.
const VALID_FROM = new Date("2026-01-01T00:00:00Z")

export async function createTestCa() {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "C=IT, O=Test, CN=Test CIE CA",
    notBefore: VALID_FROM,
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
    signingAlgorithm: alg,
    keys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  })
  async function issue(name: string, fiscalCode: string): Promise<TestSigner> {
    const own = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])
    const [surname, given] = name.split(" ")
    const leaf = await x509.X509CertificateGenerator.create({
      serialNumber: Math.floor(Math.random() * 1e9).toString(16),
      // Shaped like a CIE authentication certificate: CN "<codice fiscale>/<NIS>", serialNumber the document number.
      subject: `C=IT, 2.5.4.4=${surname}, 2.5.4.42=${given}, 2.5.4.5=IDCIT-CA00000AA, CN=${fiscalCode}/041001234567`,
      issuer: cert.subject,
      notBefore: VALID_FROM,
      notAfter: new Date(Date.now() + 365 * 86_400_000),
      signingAlgorithm: alg,
      publicKey: own.publicKey,
      signingKey: keys.privateKey,
      extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature)],
    })
    return { cert: new Uint8Array(leaf.rawData), key: own.privateKey, name, fiscalCode }
  }
  return { cert, keys, issue }
}

/** Signs a SHA-256 digest like the agent with CKM_RSA_PKCS: DigestInfo, PKCS#1 v1.5 padding, raw RSA. */
export async function cardSign(signer: TestSigner, digest: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", signer.key))
  const prefix = Buffer.from("3031300d060960864801650304020105000420", "hex")
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
  return new Uint8Array(
    privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([prefix, Buffer.from(digest)]))
  )
}

export async function samplePdf(pages = 2): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  for (let i = 0; i < pages; i++) doc.addPage([595, 842]).drawText(`Pagina ${i + 1}`, { x: 60, y: 780, size: 16, font })
  return doc.save({ useObjectStreams: true })
}

/**
 * Appends an incremental revision with the given objects (body by object number) and a cross-reference stream, the
 * way a PDF editor would. `size` is the first unused object number; the cross-reference stream takes it.
 */
export async function appendRevision(pdf: Uint8Array, objects: Record<number, string>, size: number) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false })
  const root = doc.context.trailerInfo.Root
  const prev = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(Buffer.from(pdf).toString("latin1"))?.[1]
  if (!prev) throw new Error("no startxref")
  const parts = ["\n"]
  let offset = pdf.length + 1
  const offsets = new Map<number, number>()
  for (const [n, body] of Object.entries(objects)) {
    const chunk = `${n} 0 obj\n${body}\nendobj\n`
    offsets.set(Number(n), offset)
    parts.push(chunk)
    offset += Buffer.byteLength(chunk, "latin1")
  }
  const xref = size
  offsets.set(xref, offset)
  const numbers = [...offsets.keys()].sort((a, b) => a - b)
  const data = Buffer.alloc(numbers.length * 7)
  numbers.forEach((n, i) => {
    data[i * 7] = 1
    data.writeUInt32BE(offsets.get(n) ?? 0, i * 7 + 1)
  })
  const index = numbers.flatMap((n) => [n, 1]).join(" ")
  parts.push(
    `${xref} 0 obj\n<< /Type /XRef /Size ${xref + 1} /Index [${index}] /W [1 4 2] /Root ${root} /Prev ${prev} ` +
      `/Length ${data.length} >>\nstream\n`
  )
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(pdf),
      Buffer.from(parts.join(""), "latin1"),
      data,
      Buffer.from(`\nendstream\nendobj\nstartxref\n${offset}\n%%EOF\n`, "latin1"),
    ])
  )
}
