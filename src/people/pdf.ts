import { PDFDocument, rgb, StandardFonts } from "pdf-lib"
import { fail } from "./model"
import type { PeopleConfig, StoredReceipt } from "./types"

const units = [
  "zero",
  "uno",
  "due",
  "tre",
  "quattro",
  "cinque",
  "sei",
  "sette",
  "otto",
  "nove",
  "dieci",
  "undici",
  "dodici",
  "tredici",
  "quattordici",
  "quindici",
  "sedici",
  "diciassette",
  "diciotto",
  "diciannove",
]
function words(n: number): string {
  if (n < 20) return units[n]
  if (n < 100) {
    const tens = ["", "", "venti", "trenta", "quaranta", "cinquanta", "sessanta", "settanta", "ottanta", "novanta"][
      Math.floor(n / 10)
    ]
    return `${n % 10 === 1 || n % 10 === 8 ? tens.slice(0, -1) : tens}${n % 10 ? words(n % 10) : ""}`
  }
  if (n < 1000)
    return `${n < 200 ? "" : words(Math.floor(n / 100))}cent${Math.floor((n % 100) / 10) === 8 ? "" : "o"}${n % 100 ? words(n % 100) : ""}`
  return "mille"
}
export async function receiptPdf(
  receipt: StoredReceipt,
  config: PeopleConfig,
  officerName: string
): Promise<Uint8Array> {
  if (!config.legalName || !config.address || !config.taxCode)
    fail(
      "PRECONDITION_FAILED",
      "Configure PEOPLE_LEGAL_NAME, PEOPLE_ADDRESS and PEOPLE_TAX_CODE before issuing receipts"
    )
  const doc = await PDFDocument.create()
  const page = doc.addPage([595.28, 841.89])
  const regular = await doc.embedFont(StandardFonts.Helvetica)
  const bold = await doc.embedFont(StandardFonts.HelveticaBold)
  // Standard PDF fonts cover Italian; unrepresentable profile characters are transliterated explicitly.
  const latin = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x20-\x7e\xa0-\xff€]/g, "?")
  const draw = (text: string, y: number, size = 11, strong = false, x = 48) =>
    page.drawText(latin(text), {
      x,
      y,
      size,
      font: strong ? bold : regular,
      color: rgb(0.1, 0.1, 0.1),
      maxWidth: 490,
      lineHeight: 16,
    })
  draw(config.legalName, 785, 19, true)
  draw(config.address, 760, 10)
  draw(`Codice fiscale: ${config.taxCode}`, 744, 10)
  draw(`Ricevuta n. ${receipt.number}`, 697, 13, true)
  draw(`Milano, ${receipt.issuedOn}`, 676)
  draw("Ricevuta di pagamento della quota associativa", 626, 15, true)
  draw(`Ricevuto da: ${receipt.person.name}`, 580)
  draw(`Numero socio: ${receipt.memberNumber}`, 555)
  const euros = Math.floor(receipt.amountCents / 100)
  const cents = String(receipt.amountCents % 100).padStart(2, "0")
  draw(`La somma di: € ${euros},${cents} (${words(euros)}/${cents} euro)`, 515)
  draw(`A titolo di: quota associativa per l'anno sociale ${receipt.year}`, 475)
  draw(`Modalita: ${receipt.method === "transfer" ? "Bonifico bancario" : "Contanti"}`, 435)
  draw(
    `Data pagamento: ${receipt.paidOn}${receipt.transferDate ? ` - Data bonifico: ${receipt.transferDate}` : ""}`,
    410
  )
  draw(receipt.signer === "president" ? "Il Presidente" : "Il Vicepresidente", 290, 11, true, 334)
  draw(officerName, 273, 11, false, 334)
  // Fixed eSign box is immediately below the printed office and name.
  page.drawLine({ start: { x: 334, y: 180 }, end: { x: 542, y: 180 }, thickness: 0.5 })
  draw(`${config.legalName} - C.F. ${config.taxCode}`, 73, 9)
  draw(`Ricevuta ${receipt.number} - pagina 1 di 1`, 55, 9)
  return doc.save({ useObjectStreams: false })
}
