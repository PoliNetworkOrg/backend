import { deflateSync } from "node:zlib"
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { exemptYearFor, feeYearLabel, feeYearOf, paymentReference, reminderOn, romeDay } from "@/soci/fees"
import { admitInput, harness, registerInput } from "./soci-fixtures"

const ACTOR = "usr_direttivo"
const ADA = "mock-member-ada"
const ALAN = "mock-member-alan"

async function pdf() {
  const doc = await PDFDocument.create()
  doc.addPage([200, 200])
  return new Uint8Array(await doc.save())
}

/** A valid 1×1 PNG. */
function png() {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (bytes: Buffer) => {
    let c = 0xffffffff
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data])
    const out = Buffer.alloc(body.length + 8)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(crc(body), body.length + 4)
    return out
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return new Uint8Array(
    Buffer.concat([
      Buffer.from("89504e470d0a1a0a", "hex"),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0]))),
      chunk("IEND", Buffer.alloc(0)),
    ])
  )
}

/** Mario admitted on 9 November 2026 (344), and Ada (1001) and Alan (1002) registered as admitted in March 2025. */
async function register() {
  const h = harness()
  await h.service.admit(ACTOR, admitInput())
  await h.service.register(ACTOR, registerInput(ADA, { details: { firstName: "Ada", lastName: "Lovelace" } }))
  await h.service.register(ACTOR, registerInput(ALAN))
  return h
}

/** A stored record, to change what the procedures don't (an admission date, an end). */
function socio(h: ReturnType<typeof harness>, number: number) {
  const row = h.rows.find((r) => r.number === number)
  if (!row) throw new Error(`No socio ${number}`)
  return row
}

const receipt = { transferDate: "2026-11-09", declaredCents: 500 }
const mailIds = (h: ReturnType<typeof harness>) => [...h.outbox.keys()].sort()

describe("fee rules", () => {
  it("follows the Regolamento: fee years from 1 September, the summer exemption and the reference", () => {
    expect(feeYearOf("2026-08-31")).toBe(2025)
    expect(feeYearOf("2026-09-01")).toBe(2026)
    expect(feeYearOf("2027-01-15")).toBe(2026)
    expect(feeYearLabel(2026)).toBe("2026/27")
    expect(feeYearLabel(2099)).toBe("2099/00")
    expect(exemptYearFor("2026-05-31")).toBeNull()
    expect(exemptYearFor("2026-06-01")).toBe(2026)
    expect(exemptYearFor("2026-08-31")).toBe(2026)
    expect(exemptYearFor("2026-09-01")).toBeNull()
    expect(paymentReference(2026, 344, "Mario", "Rossi")).toBe("Quota 2026/27 0344 Mario Rossi")
    expect(
      ["2026-11-30", "2026-12-01", "2026-12-20", "2026-12-21", "2026-12-31", "2027-01-01"].map(reminderOn)
    ).toEqual([null, "dec-1", "dec-1", "dec-21", "dec-21", null])
    // 23:30 UTC on 31 August is already 1 September in Rome.
    expect(romeDay(new Date("2026-08-31T23:30:00Z"))).toBe("2026-09-01")
  })
})

describe("admission", () => {
  it("records the fee year of the admission as paid, for admitted and registered soci", async () => {
    const h = await register()
    const mario = await h.service.get({ number: 344 })
    expect(mario.fee).toBe("paid")
    expect(mario.fees).toEqual([
      expect.objectContaining({
        year: 2026,
        label: "2026/27",
        status: "paid",
        amountCents: 500,
        payment: { paidOn: "2026-11-09", method: "admission", note: null, recordedBy: ACTOR },
      }),
    ])
    const ada = await h.service.get({ number: 1001 })
    expect(ada.fee).toBeNull()
    expect(ada.fees.map((f) => [f.year, f.status, f.payment?.method])).toEqual([[2024, "paid", "admission"]])
    expect((await h.service.list()).members.map((m) => [m.number, m.fee])).toEqual([
      [344, "paid"],
      [1001, null],
      [1002, null],
    ])
  })
})

describe("opening the fee year", () => {
  it("opens Due fees with the opening email, Exempt ones for the summer admissions, and nothing twice", async () => {
    const h = await register()
    // Alan was admitted in July 2026: exempt from 2026/27.
    Object.assign(socio(h, 1002), { admittedOn: "2026-07-15" })
    h.setNow("2026-11-10")
    expect(await h.service.runDaily()).toEqual({ opened: 2, reminded: 0 })
    const fees = await h.service.listFees({})
    expect(fees.year).toBe(2026)
    expect(fees.fees.map((f) => [f.number, f.fee.status, f.fee.amountCents])).toEqual([
      [344, "paid", 500],
      [1001, "due", 500],
      [1002, "exempt", 0],
    ])
    expect(fees.totals).toEqual({ due: 1, uploaded: 0, paid: 1, exempt: 1 })
    expect(mailIds(h)).toEqual(["opening:2026:2"])
    expect(h.outbox.get("opening:2026:2")).toMatchObject({
      to: "ada.lovelace@polinetwork.org",
      kind: "opening",
      data: {
        name: "Ada",
        yearLabel: "2026/27",
        amount: "5,00\u00a0€",
        deadline: "31 dicembre 2026",
        iban: "IT60X0542811101000000123456",
        reference: "Quota 2026/27 1001 Ada Lovelace",
      },
    })

    expect(await h.service.runDaily()).toEqual({ opened: 0, reminded: 0 })
    expect(mailIds(h)).toEqual(["opening:2026:2"])
  })

  it("opens nothing for an ended socio, and nothing at all without bank details", async () => {
    const h = await register()
    Object.assign(socio(h, 1001), { endedOn: "2026-10-01", endReason: "resigned" })
    const unconfigured = harness({ store: h.store, fees: { bank: null, myAreaUrl: "x", send: h.send } })
    expect(await unconfigured.service.runDaily()).toEqual({ opened: 0, reminded: 0 })
    expect(h.fees.filter((f) => f.year === 2026)).toHaveLength(1)

    expect(await h.service.runDaily()).toEqual({ opened: 1, reminded: 0 })
    expect((await h.service.listFees({})).fees.map((f) => f.number)).toEqual([344, 1002])
  })
})

describe("reminders", () => {
  it("go from 1 and 21 December to Due fees only, never twice, catching up a missed day", async () => {
    const h = await register()
    await h.service.runDaily()
    await h.service.uploadReceipt(ALAN, "usr_alan", { name: "bonifico.pdf", bytes: await pdf() }, receipt)

    h.setNow("2026-11-30")
    expect((await h.service.runDaily()).reminded).toBe(0)
    // The job didn't run on 1 December: the 2nd catches up, once.
    h.setNow("2026-12-02")
    expect((await h.service.runDaily()).reminded).toBe(1)
    expect(await h.service.runDaily()).toEqual({ opened: 0, reminded: 0 })
    h.setNow("2026-12-20")
    expect((await h.service.runDaily()).reminded).toBe(0)
    h.setNow("2026-12-21T19:00:00Z")
    expect((await h.service.runDaily()).reminded).toBe(1)
    h.setNow("2026-12-30")
    expect((await h.service.runDaily()).reminded).toBe(0)
    // Ada (record 2) is Due; Alan (record 3) uploaded his receipt.
    expect(mailIds(h).filter((id) => id.startsWith("reminder"))).toEqual([
      "reminder:2026:dec-1:2",
      "reminder:2026:dec-21:2",
    ])
  })
})

describe("receipts and review", () => {
  it("takes a PDF or PNG up to 10 MB, judged by its content", async () => {
    const h = await register()
    await h.service.runDaily()
    const upload = (bytes: Uint8Array, name = "receipt.pdf") =>
      h.service.uploadReceipt(ADA, "usr_ada", { name, bytes }, receipt)
    await expect(upload(new Uint8Array(Buffer.from("%PDF-1.7 not really")))).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(upload(new Uint8Array(Buffer.from("hello")), "receipt.png")).rejects.toThrow(/PDF, JPEG or PNG/)
    await expect(upload(new Uint8Array(10 * 1024 * 1024 + 1))).rejects.toThrow(/larger than 10 MB/)
    await expect(upload(new Uint8Array())).rejects.toThrow(/empty/)
    await expect(
      h.service.uploadReceipt(
        ADA,
        "usr_ada",
        { name: "r.pdf", bytes: await pdf() },
        { ...receipt, transferDate: "2026-11-10" }
      )
    ).rejects.toThrow(/future/)

    await upload(png(), "C:\\Users\\ada\\bonifico.png")
    const fee = (await h.service.get({ number: 1001 })).fees[0]
    expect(fee).toMatchObject({
      status: "uploaded",
      upload: { fileName: "bonifico.png", contentType: "image/png", transferDate: "2026-11-09", declaredCents: 500 },
    })
    const file = await h.service.feeFile({ fileId: fee.upload?.fileId ?? "" })
    expect(Buffer.from(file.base64, "base64")).toEqual(Buffer.from(png()))
    // A receipt waiting for review may be replaced.
    await upload(await pdf())
    expect((await h.service.get({ number: 1001 })).fees[0].upload?.contentType).toBe("application/pdf")
    expect(h.files.size).toBe(2)
  })

  it("rejects with a reason, back to Due, then confirms the next upload as paid, emailing both", async () => {
    const h = await register()
    await h.service.runDaily()
    const reviewed = async () => (await h.service.get({ number: 1001 })).fees[0].upload?.fileId ?? ""
    await expect(
      h.service.confirmFee(ACTOR, { number: 1001, year: 2026, fileId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    await h.service.uploadReceipt(ADA, "usr_ada", { name: "r.pdf", bytes: await pdf() }, receipt)
    await h.service.rejectFee(ACTOR, { number: 1001, year: 2026, fileId: await reviewed(), reason: "Amount is 3 €." })
    let fee = (await h.service.get({ number: 1001 })).fees[0]
    expect(fee).toMatchObject({ status: "due", lastRejection: { reason: "Amount is 3 €.", by: ACTOR } })
    expect(fee.upload).not.toBeNull()
    expect([...h.outbox.values()].find((m) => m.kind === "rejected")?.data.reason).toBe("Amount is 3 €.")

    h.setNow("2026-11-12")
    await h.service.uploadReceipt(
      ADA,
      "usr_ada",
      { name: "r2.pdf", bytes: await pdf() },
      {
        transferDate: "2026-11-11",
        declaredCents: 500,
      }
    )
    const first = await reviewed()
    // Ada replaces the receipt while the Direttivo reviews the first: the review doesn't apply to the new one.
    await h.service.uploadReceipt(
      ADA,
      "usr_ada",
      { name: "r3.pdf", bytes: await pdf() },
      { transferDate: "2026-11-11", declaredCents: 500 }
    )
    await expect(h.service.confirmFee(ACTOR, { number: 1001, year: 2026, fileId: first })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await h.service.confirmFee(ACTOR, { number: 1001, year: 2026, fileId: await reviewed() })
    fee = (await h.service.get({ number: 1001 })).fees[0]
    expect(fee).toMatchObject({
      status: "paid",
      payment: { paidOn: "2026-11-11", method: "transfer", recordedBy: ACTOR },
      lastRejection: { reason: "Amount is 3 €." },
    })
    expect(h.outbox.get("confirmed:2026:2")?.data.paidOn).toBe("11 novembre 2026")
    await expect(
      h.service.uploadReceipt(ADA, "usr_ada", { name: "r3.pdf", bytes: await pdf() }, receipt)
    ).rejects.toThrow(/already paid/)
    expect((await h.service.get({ number: 1001 })).activity.map((a) => a.text).slice(0, 6)).toEqual([
      "Confirmed the 2026/27 fee",
      "Uploaded a transfer receipt for 2026/27",
      "Uploaded a transfer receipt for 2026/27",
      "Rejected the 2026/27 receipt: Amount is 3 €.",
      "Uploaded a transfer receipt for 2026/27",
      "Opened the 2026/27 fee",
    ])
  })

  it("marks a fee as paid by hand, opening it when the year hasn't yet", async () => {
    const h = await register()
    await h.service.markPaid(ACTOR, { number: 1002, year: 2026, paidOn: "2026-10-02", method: "other", note: "Cash" })
    expect((await h.service.get({ number: 1002 })).fees[0]).toMatchObject({
      status: "paid",
      payment: { paidOn: "2026-10-02", method: "other", note: "Cash", recordedBy: ACTOR },
    })
    expect(h.outbox.get("confirmed:2026:3")).toMatchObject({ kind: "confirmed", to: "alan.turing@polinetwork.org" })
    // The year then opens only Ada's fee.
    expect((await h.service.runDaily()).opened).toBe(1)

    const markPaid = (input: Partial<Parameters<typeof h.service.markPaid>[1]>) =>
      h.service.markPaid(ACTOR, {
        number: 1002,
        year: 2026,
        paidOn: "2026-10-02",
        method: "transfer",
        note: null,
        ...input,
      })
    await expect(markPaid({})).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(markPaid({ year: 2027 })).rejects.toThrow(/hasn't started/)
    await expect(markPaid({ year: 2023 })).rejects.toThrow(/admitted after/)
    await expect(markPaid({ number: 1001, paidOn: "2026-11-10" })).rejects.toThrow(/future/)
    await markPaid({ number: 1001 })
    expect((await h.service.listFees({ status: "paid" })).fees.map((f) => f.number)).toEqual([344, 1001, 1002])
  })
})

describe("My area", () => {
  it("shows the socio their record, fees and how to pay, and refuses accounts without a record", async () => {
    const h = await register()
    await h.service.runDaily()
    const me = await h.service.me(ADA)
    expect(me).toMatchObject({
      number: 1001,
      details: { firstName: "Ada", residence: null, phone: null },
      missing: ["codiceFiscale", "birthDate", "birthPlace", "residence"],
      payment: {
        year: 2026,
        label: "2026/27",
        amountCents: 500,
        deadline: "2026-12-31",
        reference: "Quota 2026/27 1001 Ada Lovelace",
        iban: "IT60X0542811101000000123456",
        beneficiary: "PoliNetwork APS",
      },
    })
    expect(me.fees.map((f) => [f.year, f.status])).toEqual([
      [2026, "due"],
      [2024, "paid"],
    ])
    await expect(h.service.me("mock-member-grace")).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      h.service.uploadReceipt("mock-member-grace", "usr_grace", { name: "r.pdf", bytes: await pdf() }, receipt)
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      h.service.completeDetails("mock-member-grace", "usr_grace", {
        codiceFiscale: null,
        birthDate: null,
        birthPlace: "Roma",
        residence: null,
        phone: null,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("lets the socio fill in only their empty fields", async () => {
    const h = await register()
    const none = { codiceFiscale: null, birthDate: null, birthPlace: null, residence: null, phone: null }
    await h.service.completeDetails(ADA, "usr_ada", {
      ...none,
      residence: "Via Roma 1, Milano (MI)",
      phone: "+393331234567",
    })
    expect((await h.service.me(ADA)).missing).toEqual(["codiceFiscale", "birthDate", "birthPlace"])
    await expect(h.service.completeDetails(ADA, "usr_ada", { ...none, residence: "Via Po 2" })).rejects.toThrow(
      /Already recorded: residence/
    )
    await expect(
      h.service.completeDetails(ADA, "usr_ada", { ...none, codiceFiscale: "RSSMRA80A01H501U", birthDate: "1980-01-02" })
    ).rejects.toThrow(/doesn't match/)
    // Mario (344) is active with this code.
    await expect(
      h.service.completeDetails(ADA, "usr_ada", { ...none, codiceFiscale: "RSSMRA80A01H501U" })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    expect((await h.service.get({ number: 1001 })).activity[0]).toMatchObject({
      actor: "usr_ada",
      text: "Completed residence, phone",
    })
  })
})

describe("the outbox", () => {
  it("sends each queued email once, and records a failure", async () => {
    const h = await register()
    await h.service.runDaily()
    h.send.mockRejectedValueOnce(new Error("Graph is down"))
    await h.service.markPaid(ACTOR, { number: 1002, year: 2026, paidOn: "2026-11-01", method: "other", note: null })
    await h.service.deliverPending()
    expect(h.send).toHaveBeenCalledTimes(3)
    expect([...h.outbox.values()].map((m) => [m.id, m.status])).toEqual([
      ["opening:2026:2", "failed"],
      ["opening:2026:3", "sent"],
      ["confirmed:2026:3", "sent"],
    ])
    await h.service.deliverPending()
    expect(h.send).toHaveBeenCalledTimes(3)
    expect((await h.service.get({ number: 1001 })).activity[0].text).toBe("The opening email failed: Graph is down")
  })
})
