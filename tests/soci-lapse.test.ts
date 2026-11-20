import assert from "node:assert/strict"
import { PDFDocument } from "pdf-lib"
import { createElement } from "react"
import { describe, expect, it, vi } from "vitest"
import { FEE_PREVIEW } from "@/emails/components/fee-payment"
import { renderEmail } from "@/emails/render"
import Lapsed from "@/emails/templates/fee-lapsed"
import { harness, registerInput } from "./soci-fixtures"

async function setup(enabled = true) {
  const h = harness({ autoLapse: enabled })
  await h.service.register("usr_direttivo", registerInput("mock-member-alan"))
  h.setNow("2026-09-01")
  await h.service.runDaily()
  const fee = h.fees.find((fee) => fee.year === 2026)
  assert.ok(fee)
  const lapsed = () => [...h.outbox.values()].filter((mail) => mail.kind === "lapsed")
  return { ...h, fee, lapsed }
}

describe("automatic membership lapse", () => {
  it("stays disabled unless explicitly enabled", async () => {
    const h = await setup(false)
    h.setNow("2027-01-01")
    const remove = vi.spyOn(h.directory, "removeFromSoci")
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 0 })
    expect(remove).not.toHaveBeenCalled()
    expect(h.rows[0].endedOn).toBeNull()
    expect(h.lapsed()).toEqual([])
    expect((await h.service.lapsePreview()).enabled).toBe(false)
  })

  it("previews December's warning without changing status, and waits until midnight in Rome", async () => {
    const h = await setup()
    h.setNow("2026-12-01")
    expect(await h.service.lapsePreview()).toMatchObject({
      enabled: true,
      evaluatedOn: "2027-01-01",
      members: [{ number: 1002, year: 2026, endedOn: "2026-12-31" }],
    })
    h.setNow("2026-12-31T22:59:59Z")
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 0 })
    h.setNow("2026-12-31T23:00:00Z")
    expect(await h.service.runLapse()).toEqual({ ended: 1, failed: 0 })
    expect(h.rows[0]).toMatchObject({
      endedOn: "2026-12-31",
      endReason: "lapsed",
      accountState: "pending_deletion",
      updatedBy: "system",
    })
    expect((await h.directory.getSociMembers()).some((m) => m.id === h.rows[0].entraObjectId)).toBe(false)
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 0 })
    expect(h.lapsed()).toHaveLength(1)
    expect(h.lapsed()[0]).toMatchObject({ id: "lapsed:2026:1", to: "alan.turing@polinetwork.org" })
    expect(await h.directory.getMember(h.rows[0].entraObjectId)).not.toBeNull()
  })

  it.each(["uploaded", "paid", "exempt"] as const)("protects %s fees", async (status) => {
    const h = await setup()
    h.fee.status = status
    h.setNow("2027-01-02")
    expect((await h.service.lapsePreview()).members).toEqual([])
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 0 })
    expect(h.rows[0].endedOn).toBeNull()
  })

  it("does not infer a debt from a missing fee, and handles overdue rejections after September", async () => {
    const h = await setup()
    h.setNow("2027-10-01")
    h.fee.status = "uploaded"
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 0 })
    h.fee.status = "due"
    expect(await h.service.runLapse()).toEqual({ ended: 1, failed: 0 })
    expect(h.rows[0].endedOn).toBe("2026-12-31")
    const other = await setup()
    other.fees.splice(other.fees.indexOf(other.fee), 1)
    other.setNow("2027-01-01")
    expect(await other.service.runLapse()).toEqual({ ended: 0, failed: 0 })
  })

  it("keeps the socio active after Graph or persistence failures and retries the next day", async () => {
    const h = await setup()
    h.setNow("2027-01-01")
    vi.spyOn(h.directory, "removeFromSoci").mockRejectedValueOnce(new Error("Graph unavailable"))
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 1 })
    expect(h.rows[0].endedOn).toBeNull()
    expect(h.lapsed()).toHaveLength(0)
    vi.spyOn(h.store, "update").mockRejectedValueOnce(new Error("Database unavailable"))
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 1 })
    expect(h.rows[0].endedOn).toBeNull()
    expect((await h.directory.getSociMembers()).some((m) => m.id === h.rows[0].entraObjectId)).toBe(true)
    h.setNow("2027-01-02")
    expect(await h.service.runLapse()).toEqual({ ended: 1, failed: 0 })
    expect(h.lapsed()).toHaveLength(1)
    expect(h.logger.error).toHaveBeenCalled()
  })

  it("rechecks payment under the lifecycle lock before removing membership", async () => {
    const h = await setup()
    h.setNow("2027-01-01")
    await Promise.all([
      h.service.markPaid("usr_direttivo", {
        number: 1002,
        year: 2026,
        paidOn: "2026-12-30",
        method: "transfer",
        note: null,
      }),
      h.service.runLapse(),
    ])
    expect(h.rows[0].endedOn).toBeNull()
    expect(h.lapsed()).toHaveLength(0)
  })

  it("protects a receipt submitted concurrently, then lapses after a rejection", async () => {
    const h = await setup()
    h.setNow("2027-01-02")
    const pdf = await PDFDocument.create()
    pdf.addPage([100, 100])
    const bytes = new Uint8Array(await pdf.save())
    await Promise.all([
      h.service.uploadReceipt(
        h.rows[0].entraObjectId,
        "usr_socio",
        { name: "receipt.pdf", bytes },
        { transferDate: "2026-12-30", declaredCents: 500 }
      ),
      h.service.runLapse(),
    ])
    expect(h.fee.status).toBe("uploaded")
    expect(h.rows[0].endedOn).toBeNull()
    expect(h.lapsed()).toHaveLength(0)
    assert.ok(h.fee.fileId)
    await h.service.rejectFee("usr_direttivo", {
      number: 1002,
      year: 2026,
      fileId: h.fee.fileId,
      reason: "Ricevuta non valida",
    })
    expect(await h.service.runLapse()).toEqual({ ended: 1, failed: 0 })
    expect(h.rows[0].endedOn).toBe("2026-12-31")
  })

  it("ignores older unpaid years and tracks the account through a concurrent number change", async () => {
    const h = await setup()
    h.setNow("2028-01-01")
    expect(await h.service.runLapse()).toEqual({ ended: 0, failed: 0 })
    h.setNow("2027-01-01")
    const [, result] = await Promise.all([
      h.service.setNumber("usr_direttivo", { number: 1002, newNumber: 1102 }),
      h.service.runLapse(),
    ])
    expect(result).toEqual({ ended: 1, failed: 0 })
    expect(h.rows[0].number).toBe(1102)
    expect(h.rows[0].endedOn).toBe("2026-12-31")
  })

  it("renders an Italian lapse email with the approved card and an inline header", async () => {
    const mail = await renderEmail(createElement(Lapsed, { ...FEE_PREVIEW, name: "Mario <Rossi>" }))
    expect(mail.text).toContain("Status di socio terminato")
    expect(mail.text).toContain("31 dicembre 2026")
    expect(mail.text).toContain("direttivo@polinetwork.org")
    expect(mail.html).toContain("Mario &lt;Rossi&gt;")
    expect(mail.inlineImages[0].cid).toBe("polinetwork-header-fee-lapsed@polinetwork.org")
  })
})

describe("soci.accounts.delete", () => {
  it("refuses active and unknown accounts, then deletes a pending one without losing the register", async () => {
    const h = await setup()
    const input = { entraObjectId: h.rows[0].entraObjectId }
    const remove = vi.spyOn(h.directory, "deleteUser")
    await expect(h.service.deleteAccount("usr_direttivo", input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    await expect(h.service.deleteAccount("usr_direttivo", { entraObjectId: "unknown" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    expect(remove).not.toHaveBeenCalled()
    await h.service.end("usr_direttivo", { number: 1002, endedOn: "2026-09-01", endReason: "other", endNote: null })
    expect(await h.service.pendingDeletion()).toHaveLength(1)
    const snapshot = structuredClone(h.rows[0])
    const fees = structuredClone(h.fees)
    await h.service.deleteAccount("usr_deleter", input)
    expect(h.rows[0]).toMatchObject({
      ...snapshot,
      accountState: "deleted",
      accountDeletedOn: "2026-09-01",
      updatedBy: "usr_deleter",
    })
    expect(h.fees).toEqual(fees)
    expect(await h.store.numberOwner(1002)).toBe(h.rows[0].id)
    expect(await h.directory.getMember(input.entraObjectId)).toBeNull()
    expect(await h.service.pendingDeletion()).toHaveLength(0)
    await expect(h.service.deleteAccount("usr_deleter", input)).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
  })

  it("can finish after Graph succeeds but persistence fails, including an already absent account", async () => {
    const h = await setup()
    await h.service.end("usr_direttivo", { number: 1002, endedOn: "2026-09-01", endReason: "other", endNote: null })
    const input = { entraObjectId: h.rows[0].entraObjectId }
    vi.spyOn(h.directory, "deleteUser").mockRejectedValueOnce(new Error("Graph unavailable"))
    await expect(h.service.deleteAccount("usr_deleter", input)).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(h.rows[0].accountState).toBe("pending_deletion")
    vi.spyOn(h.store, "update").mockRejectedValueOnce(new Error("Database unavailable"))
    await expect(h.service.deleteAccount("usr_deleter", input)).rejects.toThrow(/retry to finish/i)
    expect(await h.directory.getMember(input.entraObjectId)).toBeNull()
    await h.service.deleteAccount("usr_deleter", input)
    expect(h.rows[0].accountState).toBe("deleted")
    expect(
      (await h.store.activity(h.rows[0].id)).filter((e) => e.text.includes("account ") && e.text.endsWith(" deleted"))
    ).toHaveLength(1)
  })
})
