import { describe, expect, it, vi } from "vitest"
import { myAreaSchema } from "@/people/contract"
import { isValidIban } from "@/people/iban"
import { academicYear, csvCell, today } from "@/people/model"
import { samplePdf } from "./esign-fixtures"
import { admit, harness, issue, master, permissions, vice, viewer } from "./people-fixtures"

describe("People authorization and projections", () => {
  it("validates the configured IBAN country length and mod-97 checksum", () => {
    expect(isValidIban("IT60X0542811101000000123456")).toBe(true)
    expect(isValidIban("IT61X0542811101000000123456")).toBe(false)
    expect(isValidIban("IT60X054281110100000012345")).toBe(false)
    expect(isValidIban("ZZ60X0542811101000000123456")).toBe(false)
  })
  it("does not load Telegram users for ordinary People reads", async () => {
    const telegramUsers = vi.fn(async () => [])
    const h = harness({ telegramUsers })
    await h.seed()
    await h.service.listPeople(master)
    expect(telegramUsers).not.toHaveBeenCalled()
  })
  it("keeps the member register independent of general read access", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const v = viewer("register", ["admin:access", "people:members:read"])
    const rows = await h.service.listMembers(v)
    expect(rows[2]).toEqual({
      id: "P-0003",
      profile: { firstName: "Luca", lastName: "Verdi", personalEmail: null },
      member: expect.objectContaining({ number: "0003" }),
      account: { status: "linked" },
    })
    expect(rows[0].member).toBeNull()
    await expect(h.service.listPeople(v)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(h.service.listMembers(viewer("stray", ["people:members:read"]))).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(
      h.service.listMembers(viewer("write-only", ["admin:access", "people:members:write"]))
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("redacts member details from People reads but keeps own membership in My area", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const read = viewer("reader", ["admin:access", "people:read"])
    const p = await h.service.getPerson(read, { id: "P-0003" })
    expect(p).toMatchObject({ isMember: true, member: null, fees: null })
    const mine = await h.service.getMyArea(viewer("member", ["people:self"]))
    expect(myAreaSchema.parse(mine)).toMatchObject({
      state: "linked",
      person: { member: { number: "0003" }, notes: null, fees: { current: { status: "due" } } },
    })
    expect(JSON.stringify(mine)).not.toContain("accountSub")
  })
  it("scopes Leads to their confirmed teams and requires appointment rights to end another Lead", async () => {
    const h = harness()
    await h.seed()
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0001",
      role: "lead",
      since: "2026-10-01",
      fields: {},
    })
    const lead = viewer("president", ["people:self", "people:read"])
    expect((await h.service.listTeams(lead)).map((t) => t.id)).toEqual(["it"])
    await h.service.addTeamMember(lead, {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: { areas: ["Backend"] },
    })
    await expect(h.service.listTeamCandidates(lead, { teamId: "hr" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      h.service.endTeamMembership(lead, {
        teamId: "it",
        personId: "P-0001",
        lastDay: "2026-10-18",
        reason: "Leaving",
        note: "",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.endTeamMembership(lead, {
      teamId: "it",
      personId: "P-0003",
      lastDay: "2026-10-18",
      reason: "Leaving",
      note: "",
    })
    expect(h.state().persons["P-0003"].teams[0].endedOn).toBe("2026-10-18")
  })
  it("does not expose former team members to a Team Lead", async () => {
    const h = harness()
    await h.seed()
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0001",
      role: "lead",
      since: "2026-10-01",
      fields: {},
    })
    await h.service.addTeamMember(master, {
      teamId: "it",
      personId: "P-0003",
      role: "member",
      since: "2026-10-01",
      fields: {},
    })
    await h.service.endTeamMembership(master, {
      teamId: "it",
      personId: "P-0003",
      lastDay: "2026-10-18",
      reason: "Leaving",
      note: "",
    })
    const teams = await h.service.listTeams(viewer("president", ["people:self"]))
    expect(teams[0].members.map((p) => p.id)).toEqual(["P-0001"])
  })
  it("preserves every correction when an open name review already exists", async () => {
    const h = harness()
    await h.seed()
    const member = viewer("member", ["people:self"])
    await h.service.requestCorrection(member, { field: "Something else", value: "Luca Maria", note: "Updated name" })
    await h.service.requestCorrection(member, {
      field: "Personal email",
      value: "luca.new@example.org",
      note: "New address",
    })
    expect(Object.values(h.state().reviews)).toHaveLength(1)
    expect(Object.values(h.state().reviews)[0].message).toContain(
      "Correction: Something else → Luca Maria; Updated name"
    )
    expect(Object.values(h.state().reviews)[0].message).toContain(
      "Correction: Personal email → luca.new@example.org; New address"
    )
  })
  it("does not grant record roles or mutation rights to an unconfirmed match", async () => {
    const h = harness()
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      const p = state.persons["P-0001"]
      p.accountSub = null
      p.account = { status: "none" }
      if (p.admin) p.admin.capoScope = "IT"
      p.teams.push({ team: "it", role: "lead", since: "2026-10-01", endedOn: null, endReason: null, fields: {} })
    })
    const v = viewer("president", ["people:self"], "101")
    expect(await h.service.getMyArea(v)).toMatchObject({ state: "match", candidate: { id: "P-0001" } })
    expect(await h.service.getMyRoles(v)).toEqual({ capoScope: null, leads: [] })
    await expect(h.service.getCapoArea(v)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(h.service.revokePhotoConsent(v)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.rejectMatch(v)
    expect(await h.service.getMyArea(v)).toMatchObject({ state: "none" })
    await expect(h.service.confirmMatch(v)).rejects.toMatchObject({ code: "CONFLICT" })
  })
  it("does not trust an unverified directory email for self matching", async () => {
    const h = harness()
    await h.seed()
    await h.store.transaction(async ({ state }) => {
      state.persons["P-0003"].accountSub = null
      state.persons["P-0003"].account = { status: "none" }
    })
    h.accounts[2].emailVerified = false
    expect(await h.service.getMyArea(viewer("member", ["people:self"]))).toMatchObject({ state: "none" })
    h.accounts[2].emailVerified = true
    expect(await h.service.getMyArea(viewer("member", ["people:self"]))).toMatchObject({ state: "match" })
  })
  it("prevents account takeover and invalidates old invitation tokens", async () => {
    const h = harness()
    await h.seed()
    await expect(
      h.service.linkAccount(master, { personId: "P-0003", accountId: "president", reason: "Test" })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await h.service.unlinkAccount(master, { personId: "P-0003" })
    await h.service.sendInvite(master, { personId: "P-0003" })
    const first = Object.values(h.state().outbox).at(-1)?.text.split("peopleInvite=")[1] ?? ""
    await h.service.sendInvite(master, { personId: "P-0003" })
    await expect(h.service.acceptInvite(viewer("member", ["people:self"]), { token: first })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    const last = Object.values(h.state().outbox).at(-1)?.text.split("peopleInvite=")[1] ?? ""
    await expect(h.service.acceptInvite(viewer("vice", ["people:self"]), { token: last })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await h.service.acceptInvite(viewer("member", ["people:self"]), { token: last })
    expect(h.state().persons["P-0003"].accountSub).toBe("member")
  })
})

describe("People payments, receipt ownership and delivery", () => {
  it("cannot replace a membership or claim a non-uploaded transfer", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    await expect(admit(h)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(h.provisionMember).toHaveBeenCalledTimes(1)
    await expect(h.service.approveFee(master, { personId: "P-0003" })).rejects.toMatchObject({ code: "CONFLICT" })
    await expect(
      h.service.createMember(viewer("membership", ["admin:access", "people:members:write"]), {
        personId: "P-0002",
        number: "0002",
        admittedOn: "2026-10-01",
        fee: "paid",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
  it("reviews actual uploads, keeps rejection history and issues one receipt atomically", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const me = viewer("member", ["people:self"])
    const file = new File([new Uint8Array(await samplePdf())], "transfer.pdf")
    await h.service.uploadTransferReceipt(me, { file, transferDate: "2026-10-16", amountCents: 1000 })
    await expect(
      h.service.markFeePaid(master, {
        personId: "P-0003",
        amountCents: 1000,
        paidOn: "2026-10-16",
        method: "cash",
        note: "",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await h.service.rejectFee(master, { personId: "P-0003", reason: "Wrong beneficiary" })
    expect(h.state().persons["P-0003"].feeYears["2026/27"]).toMatchObject({
      status: "due",
      rejection: { reason: "Wrong beneficiary" },
      fileId: null,
    })
    await h.service.uploadTransferReceipt(me, { file, transferDate: "2026-10-17", amountCents: 1000 })
    const result = await Promise.allSettled([
      h.service.approveFee(master, { personId: "P-0003" }),
      h.service.approveFee(master, { personId: "P-0003" }),
    ])
    expect(result.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(Object.values(h.state().receipts)).toHaveLength(1)
    expect((await h.service.getFeeReview(master, { personId: "P-0003" })).rejections).toHaveLength(1)
  })
  it("keeps receipt numbering after void and assigns the President's own receipt to the Vice-president", async () => {
    const h = harness()
    await h.seed()
    await admit(h, "P-0001", "0001")
    const receipt = await issue(h, "P-0001")
    expect(receipt).toMatchObject({ number: "2026/001", signer: "vicePresident" })
    await expect(h.service.prepareReceiptSignatures(master, { receiptIds: [receipt.id] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    const prepared = await h.service.prepareReceiptSignatures(vice, { receiptIds: [receipt.id] })
    expect(await h.service.prepareReceiptSignatures(vice, { receiptIds: [receipt.id] })).toEqual(prepared)
    await h.service.voidReceipt(master, { receiptId: receipt.id, reason: "Wrong amount" })
    expect(h.requests.get(prepared[0].requestId)?.status).toBe("cancelled")
    expect((await issue(h, "P-0001")).number).toBe("2026/002")
    expect(Object.values(h.state().receipts)).toHaveLength(2)
  })
  it("validates a full preparation batch before creating requests and requires both CIE permissions", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const r = await issue(h)
    await admit(h, "P-0001", "0001")
    const other = await issue(h, "P-0001")
    await expect(h.service.prepareReceiptSignatures(master, { receiptIds: [r.id, other.id] })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    expect(h.requests.size).toBe(0)
    await expect(
      h.service.prepareReceiptSignatures(
        viewer(
          "president",
          permissions.filter((p) => p !== "esign:sign")
        ),
        { receiptIds: [r.id] }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(h.service.prepareReceiptSignatures(master, { receiptIds: [r.id, r.id] })).rejects.toThrow()
    const [prepared] = await h.service.prepareReceiptSignatures(master, { receiptIds: [r.id] })
    expect(await h.service.eligibleReceipt(prepared.requestId, "president", master.can)).toBe(true)
    expect(await h.service.eligibleReceipt(prepared.requestId, "vice", vice.can)).toBe(false)
    await h.service.unlinkAccount(master, { personId: "P-0001" })
    expect(await h.service.eligibleReceipt(prepared.requestId, "president", master.can)).toBe(false)
  })
  it("hides unsigned, another member's and voided receipts from self downloads", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const r = await issue(h)
    await expect(
      h.service.downloadMyReceipt(viewer("member", ["people:self"]), { receiptId: r.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(
      h.service.downloadMyReceipt(viewer("vice", ["people:self"]), { receiptId: r.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(await h.service.downloadReceipt(master, { receiptId: r.id })).toMatchObject({
      contentType: "application/pdf",
    })
  })
  it("sends a durable outbox item once across concurrent workers and exposes failures for retry", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const r = await issue(h)
    await h.store.transaction(async ({ state, putFile }) => {
      const receipt = state.receipts[r.id]
      receipt.status = "signed"
      receipt.signedFileId = "signed"
      await putFile({
        id: "signed",
        content: new Uint8Array([1]),
        fileName: "signed.pdf",
        contentType: "application/pdf",
        expiresAt: null,
      })
      state.outbox[`receipt:${r.id}`] = {
        id: `receipt:${r.id}`,
        personId: r.person.id,
        receiptId: r.id,
        to: r.recipient,
        subject: "Receipt",
        text: "Receipt",
        fileId: "signed",
        status: "pending",
        attemptedAt: null,
        error: null,
      }
    })
    h.sendMail.mockRejectedValueOnce(new Error("Mailbox unavailable"))
    await Promise.all([h.service.deliverPending(), h.service.deliverPending()])
    expect(h.sendMail).toHaveBeenCalledTimes(1)
    expect(h.state().receipts[r.id]).toMatchObject({ status: "failed", failure: "Mailbox unavailable" })
    await h.service.retryReceipt(master, { receiptId: r.id })
    expect(h.sendMail).toHaveBeenCalledTimes(2)
    expect(h.state().receipts[r.id]).toMatchObject({ status: "sent", sentTo: "luca@polinetwork.org" })
    await h.service.deliverPending()
    expect(h.sendMail).toHaveBeenCalledTimes(2)
  })
  it("does not resend mail whose outcome is unknown after a crash", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    const r = await issue(h)
    await h.store.transaction(async ({ state }) => {
      state.receipts[r.id].status = "signed"
      state.outbox[`receipt:${r.id}`] = {
        id: `receipt:${r.id}`,
        personId: r.person.id,
        receiptId: r.id,
        to: r.recipient,
        subject: "Receipt",
        text: "Receipt",
        fileId: null,
        status: "sending",
        attemptedAt: "2026-10-18T09:00:00Z",
        error: null,
      }
    })
    await h.service.deliverPending()
    expect(h.sendMail).not.toHaveBeenCalled()
    expect(h.state().receipts[r.id]).toMatchObject({
      status: "failed",
      failure: expect.stringContaining("outcome unknown"),
    })
  })
  it("rolls fee years and automatic reminders using dates in Rome", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    h.setDate("2026-10-17T10:00:00Z")
    await h.service.sweep()
    await h.service.sweep()
    expect(h.sendMail).toHaveBeenCalledTimes(1)
    h.setDate("2026-10-28T10:00:00Z")
    await h.service.sweep()
    expect(h.sendMail).toHaveBeenCalledTimes(2)
    h.setDate("2026-11-01T10:00:00Z")
    expect((await h.service.getFeeReview(master, { personId: "P-0003" })).fee.status).toBe("unpaid")
    h.setDate("2027-09-01T10:00:00Z")
    expect((await h.service.getFeeReview(master, { personId: "P-0003" })).fee).toMatchObject({
      year: "2027/28",
      status: "due",
    })
    expect(today(new Date("2026-08-31T22:30:00Z"))).toBe("2026-09-01")
    expect(academicYear("2026-08-31")).toBe("2025/26")
  })
  it("quotes and neutralizes every CSV cell", () => {
    for (const text of ["=A1", "+x", "-x", "@x", "\tX", "\rX"]) expect(csvCell(text)).toBe(`"'${text}"`)
    expect(csvCell('a,"b"')).toBe('"a,""b"""')
  })
  it("counts delivered reminders, releases failed sends and enforces the three-day cooldown", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    h.sendMail.mockRejectedValueOnce(new Error("Mailbox temporarily unavailable"))
    expect(await h.service.remindFees(master, { personId: "P-0003" })).toEqual({ sent: 0, skipped: 1 })
    expect(await h.service.remindFees(master, { personId: "P-0003" })).toEqual({ sent: 1, skipped: 0 })
    expect(await h.service.remindFees(master, { personId: "P-0003" })).toEqual({ sent: 0, skipped: 1 })
    expect(h.sendMail).toHaveBeenCalledTimes(2)
  })
  it("does not change a member number when Microsoft 365 refuses the update", async () => {
    const h = harness()
    await h.seed()
    await admit(h)
    h.setMemberNumber.mockRejectedValueOnce(new Error("Microsoft 365 unavailable"))
    await expect(h.service.setMemberNumber(master, { personId: "P-0003", number: "0042" })).rejects.toThrow(
      "unavailable"
    )
    expect(h.state().persons["P-0003"].member?.number).toBe("0003")
  })
})

it("retains deselected census groups as pending HR work until Telegram confirms removal", async () => {
  const groups = [{ chatId: "-1001", title: "Test group", admins: ["103"] }]
  const h = harness({ telegramGroups: async () => groups })
  await h.seed()
  await h.service.listPeople(master)
  await h.service.answerCensus(viewer("member", ["people:self"], "103"), {
    answer: "continues",
    course: "Computer science",
    year: "2nd year",
    campus: "Leonardo",
    keepGroups: [],
    keepTeams: [],
    reason: "",
    note: "",
  })
  let person = await h.service.getPerson(master, { id: "P-0003" })
  expect(person.admin?.groups).toHaveLength(1)
  expect(person.discrepancies).toContainEqual(
    expect.objectContaining({
      kind: "needs-review",
      message: expect.stringContaining("Telegram admin removal pending: Test group (-1001)"),
    })
  )
  expect(h.state().persons["P-0003"].pendingGroupRemovals).toHaveLength(1)
  await h.store.transaction(async ({ state }) => {
    state.persons["P-0003"].discrepancies.push({
      kind: "needs-review",
      message: "HR-only identity review",
      suggestedTelegram: null,
    })
  })
  const ownArea = await h.service.getMyArea(viewer("member", ["people:self"], "103"))
  expect(ownArea).toMatchObject({
    state: "linked",
    person: {
      discrepancies: [
        expect.objectContaining({
          message: expect.stringContaining("Telegram admin removal pending:"),
        }),
      ],
    },
  })
  groups[0].admins = []
  person = await h.service.getPerson(master, { id: "P-0003" })
  expect(person.admin?.groups).toHaveLength(0)
  expect(person.discrepancies).not.toContainEqual(
    expect.objectContaining({ message: expect.stringContaining("Telegram admin removal pending:") })
  )
  expect(h.state().persons["P-0003"].pendingGroupRemovals).toHaveLength(0)
  expect(await h.service.getMyArea(viewer("member", ["people:self"], "103"))).toMatchObject({
    state: "linked",
    person: { discrepancies: [] },
  })
})
