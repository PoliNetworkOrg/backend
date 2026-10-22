import "reflect-metadata"
import { execFileSync } from "node:child_process"
import { constants, createPrivateKey, privateEncrypt, webcrypto } from "node:crypto"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as x509 from "@peculiar/x509"
import { degrees, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts } from "pdf-lib"
import { beforeAll, describe, expect, it } from "vitest"
import { addSignaturePlaceholder } from "@/esign/pdf/incremental"
import { inspectPdf } from "@/esign/pdf/inspect"
import { finalizeSignature, prepareSignature, SignatureError } from "@/esign/pdf/pades"

x509.cryptoProvider.set(webcrypto as unknown as Crypto)

const alg = {
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
}

type Signer = { cert: Uint8Array; key: webcrypto.CryptoKey; name: string }
let ca: x509.X509Certificate
let secretary: Signer
let president: Signer

async function issue(name: string, fiscalCode: string, caKeys: CryptoKeyPair): Promise<Signer> {
  const keys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])
  const [surname, given] = name.split(" ")
  const cert = await x509.X509CertificateGenerator.create({
    serialNumber: Math.floor(Math.random() * 1e9).toString(16),
    subject: `C=IT, 2.5.4.4=${surname}, 2.5.4.42=${given}, 2.5.4.5=TINIT-${fiscalCode}, CN=${name}`,
    issuer: ca.subject,
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 365 * 86_400_000),
    signingAlgorithm: alg,
    publicKey: keys.publicKey,
    signingKey: caKeys.privateKey,
    extensions: [new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.nonRepudiation)],
  })
  return { cert: new Uint8Array(cert.rawData), key: keys.privateKey, name }
}

/** Signs a SHA-256 digest the way the agent does with CKM_RSA_PKCS: DigestInfo, PKCS#1 v1.5 padding, raw RSA. */
async function cardSign(signer: Signer, digest: Uint8Array): Promise<Uint8Array> {
  const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", signer.key))
  const prefix = Buffer.from("3031300d060960864801650304020105000420", "hex")
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })
  return new Uint8Array(
    privateEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.concat([prefix, Buffer.from(digest)]))
  )
}

async function samplePdf(useObjectStreams: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const first = doc.addPage([595, 842])
  first.drawText("Verbale della riunione del Consiglio Direttivo", { x: 60, y: 780, size: 16, font })
  const second = doc.addPage([595, 842])
  second.setRotation(degrees(90))
  second.drawText("Pagina ruotata", { x: 60, y: 780, size: 16, font })
  return doc.save({ useObjectStreams })
}

async function sign(pdf: Uint8Array, signer: Signer, page: number, fieldName: string) {
  const prepared = await prepareSignature(pdf, signer.cert, {
    placement: { page, x: 0.55, y: 0.8, width: 0.35, height: 0.1 },
    fieldName,
    signerName: signer.name,
    reason: "Approvazione del verbale",
    signingTime: new Date(),
    appearance: {
      lines: [
        { text: "Firmato digitalmente da", muted: true },
        { text: signer.name, bold: true },
        { text: "17/10/2026 10:30", muted: true },
      ],
    },
  })
  const signature = await cardSign(signer, prepared.toBeSigned)
  return finalizeSignature(prepared, signature, [new Uint8Array(ca.rawData)])
}

function pdfsig(pdf: Uint8Array): string | null {
  try {
    execFileSync("pdfsig", ["-v"], { stdio: "ignore" })
  } catch {
    return null
  }
  const dir = mkdtempSync(join(tmpdir(), "esign-"))
  const path = join(dir, "signed.pdf")
  writeFileSync(path, pdf)
  try {
    return execFileSync("pdfsig", ["-nocert", path], { encoding: "utf8" })
  } catch (error) {
    return (error as { stdout?: string }).stdout ?? String(error)
  }
}

beforeAll(async () => {
  const caKeys = await webcrypto.subtle.generateKey(alg, true, ["sign", "verify"])
  ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "C=IT, O=Test, CN=Test CIE CA",
    notBefore: new Date(Date.now() - 86_400_000),
    notAfter: new Date(Date.now() + 3650 * 86_400_000),
    signingAlgorithm: alg,
    keys: caKeys,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  })
  secretary = await issue("ROSSI MARIO", "RSSMRA80A01F205X", caKeys)
  president = await issue("BIANCHI ANNA", "BNCNNA85B41F205Y", caKeys)
}, 30_000)

describe.each([
  ["classic cross-reference table", false],
  ["cross-reference streams", true],
])("PAdES with %s", (_label, useObjectStreams) => {
  it("keeps the first signature valid after a second signer", async () => {
    const original = await samplePdf(useObjectStreams)
    const once = await sign(original, secretary, 0, "Firma Segretario")
    expect(Buffer.from(once.subarray(0, original.length)).equals(Buffer.from(original))).toBe(true)
    const twice = await sign(once, president, 1, "Firma Presidente")
    expect(Buffer.from(twice.subarray(0, once.length)).equals(Buffer.from(once))).toBe(true)

    const info = await inspectPdf(twice)
    expect(info.pages).toHaveLength(2)
    expect(info.pages[1]).toEqual({ width: 842, height: 595 })
    expect(info.signatures.map((s) => s.fieldName)).toEqual(["Firma Segretario", "Firma Presidente"])
    expect(info.signatures.map((s) => s.fiscalCode)).toEqual(["RSSMRA80A01F205X", "BNCNNA85B41F205Y"])
    expect(info.signatures.every((s) => s.intact && s.verified)).toBe(true)
    expect(info.signatures.map((s) => s.coversWholeDocument)).toEqual([false, true])
    expect(info.signatures[1].page).toBe(1)

    if (process.env.ESIGN_DUMP_DIR)
      writeFileSync(
        join(process.env.ESIGN_DUMP_DIR, `signed-${useObjectStreams ? "xrefstream" : "classic"}.pdf`),
        twice
      )
    const report = pdfsig(twice)
    if (report !== null) {
      expect(report.match(/Signature Validation: Signature is Valid\./g)).toHaveLength(2)
      expect(report).toContain("Total document signed")
      expect(report).toContain("ETSI.CAdES.detached")
    }
  })
})

it.runIf(process.env.ESIGN_SAMPLE_PDF)("signs a real-world PDF twice (ESIGN_SAMPLE_PDF)", async () => {
  const { readFileSync } = await import("node:fs")
  const original = new Uint8Array(readFileSync(process.env.ESIGN_SAMPLE_PDF as string))
  const twice = await sign(await sign(original, secretary, 0, "Firma Segretario"), president, 0, "Firma Presidente")
  const info = await inspectPdf(twice)
  expect(info.signatures.every((s) => s.intact && s.verified)).toBe(true)
  if (process.env.ESIGN_DUMP_DIR) {
    writeFileSync(join(process.env.ESIGN_DUMP_DIR, "signed-sample.pdf"), twice)
    writeFileSync(join(process.env.ESIGN_DUMP_DIR, "ca.pem"), ca.toString("pem"))
  }
})

it("rejects a signature by another key", async () => {
  const pdf = await samplePdf(true)
  const prepared = await prepareSignature(pdf, secretary.cert, {
    placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
    fieldName: "Firma",
    signerName: secretary.name,
    signingTime: new Date(),
    appearance: { lines: [{ text: secretary.name, bold: true }] },
  })
  const wrong = await cardSign(president, prepared.toBeSigned)
  expect(() => finalizeSignature(prepared, wrong)).toThrow(SignatureError)
})

it("inspects a PDF whose fields reference themselves without looping", async () => {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  const ref = doc.context.nextRef()
  const field = doc.context.obj({ FT: "Sig", T: PDFString.of("loop") })
  field.set(PDFName.of("Kids"), doc.context.obj([ref, ref, ref]))
  doc.context.assign(ref, field)
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [ref] }))
  const started = Date.now()
  const info = await inspectPdf(await doc.save())
  expect(Date.now() - started).toBeLessThan(2000)
  expect(info.fieldNames).toEqual(["loop"])
})

it("signs a classic PDF whose cross-reference table is longer than 64 KB", async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  for (let i = 0; i < 4000; i++) doc.context.register(doc.context.obj({ Filler: i }))
  const pdf = await doc.save({ useObjectStreams: false })
  const signed = await sign(pdf, secretary, 0, "Firma")
  expect((await inspectPdf(signed)).signatures[0]).toMatchObject({ intact: true, verified: true })
})

it("refuses documents certified against changes, also with an indirect permission", async () => {
  const doc = await PDFDocument.create()
  doc.addPage([595, 842])
  const p = doc.context.register(PDFNumber.of(1))
  const sig = doc.context.obj({ Reference: [{ TransformMethod: "DocMDP", TransformParams: { P: p } }] })
  doc.catalog.set(PDFName.of("Perms"), doc.context.obj({ DocMDP: doc.context.register(sig) }))
  await expect(sign(await doc.save(), secretary, 0, "Firma")).rejects.toThrow(/certified/)
})

it("refuses a page that does not exist", async () => {
  const pdf = await samplePdf(false)
  await expect(
    addSignaturePlaceholder(pdf, {
      placement: { page: 5, x: 0, y: 0, width: 0.1, height: 0.1 },
      fieldName: "x",
      signerName: "x",
      signingTime: new Date(),
      appearance: { lines: [] },
    })
  ).rejects.toThrow(/2 pages/)
})
