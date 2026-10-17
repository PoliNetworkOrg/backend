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

export async function createTestCa() {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "C=IT, O=Test, CN=Test CIE CA",
    notBefore: new Date(Date.now() - 86_400_000),
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
      notBefore: new Date(Date.now() - 86_400_000),
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
