import { describe, expect, it, vi } from "vitest"
import { endInputSchema, restoreInputSchema } from "@/soci/contract"
import { admitInput, harness, registerInput, VALID_CF } from "./soci-fixtures"

const ACTOR = "usr_direttivo"
const ID = "mock-member-alan"
const end = endInputSchema.parse({
  number: 1002,
  endedOn: "2026-11-09",
  endReason: "resigned",
  endNote: "Dimissioni ricevute",
})
const restore = { number: 1002, reason: "Cessazione registrata per errore" }

describe("manual lifecycle inputs", () => {
  it("accepts only manual reasons, valid dates and bounded notes", () => {
    for (const endReason of ["resigned", "expelled", "deceased", "other"])
      expect(endInputSchema.safeParse({ ...end, endReason }).success).toBe(true)
    for (const input of [
      { ...end, endReason: "lapsed" },
      { ...end, endReason: "" },
      { ...end, endedOn: "2026-02-30" },
      { ...end, endNote: "x".repeat(501) },
      { ...end, number: 0 },
    ])
      expect(endInputSchema.safeParse(input).success).toBe(false)
    expect(endInputSchema.parse({ ...end, endNote: "  " }).endNote).toBeNull()
    expect(endInputSchema.parse({ number: 1002, endedOn: end.endedOn, endReason: "other" }).endNote).toBeNull()
  })

  it("requires a nonblank reason for a correction", () => {
    for (const reason of [undefined, "", "  ", "x".repeat(501)])
      expect(restoreInputSchema.safeParse({ ...restore, reason }).success).toBe(false)
    expect(restoreInputSchema.parse({ ...restore, reason: "  Errore  " }).reason).toBe("Errore")
  })
})

async function prepare(action: "end" | "restore") {
  const h = harness()
  await h.service.register(ACTOR, registerInput(ID))
  if (action === "restore") await h.service.end(ACTOR, end)
  h.setNow("2026-11-10T09:00:00Z")
  return {
    ...h,
    run: () => (action === "end" ? h.service.end(ACTOR, end) : h.service.restore(ACTOR, restore)),
    write: action === "end" ? ("removeFromSoci" as const) : ("addToSoci" as const),
    undo: action === "end" ? ("addToSoci" as const) : ("removeFromSoci" as const),
  }
}

describe("soci.members.end and restore", () => {
  it("ends and corrects membership without changing the account, numbers, fees or previous history", async () => {
    const h = await prepare("end")
    const { id, ...before } = structuredClone(h.rows[0])
    const fees = structuredClone(h.fees)
    const numbers = [...h.numbers]
    const account = await h.directory.getMember(ID)

    await h.run()
    expect(await h.service.get({ number: 1002 })).toMatchObject({
      ...before,
      endedOn: end.endedOn,
      endReason: "resigned",
      endNote: end.endNote,
      accountState: "pending_deletion",
      accountDeletedOn: null,
      inSoci: false,
      mismatch: null,
      updatedBy: ACTOR,
      updatedAt: "2026-11-10T09:00:00.000Z",
    })
    expect(await h.directory.getMember(ID)).toEqual(account)

    h.setNow("2026-11-11T10:00:00Z")
    await h.service.restore("usr_other_direttivo", restore)
    const record = await h.service.get({ number: 1002 })
    expect(record).toMatchObject({
      ...before,
      endedOn: null,
      endReason: null,
      endNote: null,
      accountState: "active",
      inSoci: true,
      mismatch: null,
      updatedBy: "usr_other_direttivo",
      updatedAt: "2026-11-11T10:00:00.000Z",
    })
    expect(record.activity).toEqual([
      { actor: "usr_other_direttivo", text: `Membership restored: ${restore.reason}`, at: record.updatedAt },
      {
        actor: ACTOR,
        text: `Membership ended on ${end.endedOn} (resigned): ${end.endNote}`,
        at: "2026-11-10T09:00:00.000Z",
      },
      expect.objectContaining({ text: "Registered from Microsoft 365 with number 1002" }),
    ])
    expect(h.fees).toEqual(fees)
    expect([...h.numbers]).toEqual(numbers)
    expect(await h.directory.getMember(ID)).toEqual(account)
    expect(h.send).not.toHaveBeenCalled()
    expect(h.outbox.size).toBe(0)
    expect(h.rows[0].id).toBe(id)
  })

  it("refuses restoration when the account was deleted, even before bookkeeping catches up", async () => {
    const h = await prepare("restore")
    await h.directory.deleteUser(ID)
    const update = vi.spyOn(h.store, "update")
    const add = vi.spyOn(h.directory, "addToSoci")
    await expect(h.run()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    h.rows[0].accountState = "deleted"
    h.rows[0].accountDeletedOn = "2026-11-10"
    await expect(h.run()).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    expect(update).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })

  it("refuses to restore an old admission when another active one has its codice fiscale", async () => {
    const h = harness()
    await h.service.register(
      ACTOR,
      registerInput(ID, { details: { firstName: "Mario", lastName: "Rossi", codiceFiscale: VALID_CF } })
    )
    await h.service.end(ACTOR, end)
    await h.service.admit(ACTOR, admitInput())
    const add = vi.spyOn(h.directory, "addToSoci")
    await expect(h.service.restore(ACTOR, restore)).rejects.toMatchObject({ code: "CONFLICT" })
    expect(h.rows[0].accountState).toBe("pending_deletion")
    expect(add).not.toHaveBeenCalled()
  })

  it("keeps the ended status when reading the account fails", async () => {
    const h = await prepare("restore")
    const before = structuredClone(h.rows)
    vi.spyOn(h.directory, "getMember").mockRejectedValueOnce(new Error("Graph unavailable"))
    const add = vi.spyOn(h.directory, "addToSoci")
    await expect(h.run()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(h.rows).toEqual(before)
    expect(add).not.toHaveBeenCalled()
    expect(h.logger.error).toHaveBeenCalled()
  })

  it("serializes a correction submitted while the end is still in flight", async () => {
    const h = await prepare("end")
    const ending = h.run()
    const restoring = h.service.restore(ACTOR, restore)
    await Promise.all([ending, restoring])
    expect(await h.service.get({ number: 1002 })).toMatchObject({
      endedOn: null,
      accountState: "active",
      inSoci: true,
      mismatch: null,
    })
    expect(await h.store.activity(h.rows[0].id)).toHaveLength(3)
  })

  it.each([
    "end",
    "restore",
  ] as const)("restores the latest confirmed membership when a subsequent %s fails with a stale listing", async (action) => {
    const h = await prepare(action === "end" ? "restore" : "end")
    const staleGroup = await h.directory.getSociMembers()
    await h.run()
    const group = await h.directory.getSociMembers()
    const before = structuredClone(h.rows)
    const history = await h.store.activity(h.rows[0].id)
    vi.spyOn(h.directory, "getSociMembers").mockResolvedValueOnce(staleGroup)
    vi.spyOn(h.store, "update").mockRejectedValueOnce(new Error("Database unavailable"))
    const undo = vi.spyOn(h.directory, h.write)

    const result = action === "end" ? h.service.end(ACTOR, end) : h.service.restore(ACTOR, restore)
    await expect(result).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(await h.directory.getSociMembers()).toEqual(group)
    expect(h.rows).toEqual(before)
    expect(await h.store.activity(h.rows[0].id)).toEqual(history)
    expect(undo).toHaveBeenCalledExactlyOnceWith(ID)
  })

  it.each(["end", "restore"] as const)("refuses an unknown record for %s", async (action) => {
    const h = harness()
    const result = action === "end" ? h.service.end(ACTOR, end) : h.service.restore(ACTOR, restore)
    await expect(result).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it.each(["end", "restore"] as const)("serializes repeated %s requests and records one transition", async (action) => {
    const h = await prepare(action)
    const history = await h.store.activity(h.rows[0].id)
    const write = vi.spyOn(h.directory, h.write)
    const results = await Promise.allSettled([h.run(), h.run()])
    expect(results[0].status).toBe("fulfilled")
    expect(results[1]).toMatchObject({ status: "rejected", reason: { code: "CONFLICT" } })
    expect(write).toHaveBeenCalledExactlyOnceWith(ID)
    expect(await h.store.activity(h.rows[0].id)).toHaveLength(history.length + 1)
  })

  it.each(["end", "restore"] as const)("does not save %s when reading the Soci group fails", async (action) => {
    const h = await prepare(action)
    const before = structuredClone(h.rows)
    vi.spyOn(h.directory, "getSociMembers").mockRejectedValueOnce(new Error("Graph unavailable"))
    const write = vi.spyOn(h.directory, h.write)
    const update = vi.spyOn(h.store, "update")
    await expect(h.run()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(h.rows).toEqual(before)
    expect(write).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
    expect(h.logger.error).toHaveBeenCalled()
  })

  it.each(["end", "restore"] as const)("does not save %s when Microsoft 365 refuses the change", async (action) => {
    const h = await prepare(action)
    const before = structuredClone(h.rows)
    vi.spyOn(h.directory, h.write).mockRejectedValueOnce(new Error("Graph refused the change"))
    const update = vi.spyOn(h.store, "update")
    await expect(h.run()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(h.rows).toEqual(before)
    expect(update).not.toHaveBeenCalled()
    expect(h.logger.error).toHaveBeenCalled()
    await h.run()
    expect(h.rows[0].accountState).toBe(action === "end" ? "pending_deletion" : "active")
  })

  it.each([
    "end",
    "restore",
  ] as const)("undoes the group change when saving %s fails, and can retry", async (action) => {
    const h = await prepare(action)
    const before = structuredClone(h.rows)
    const history = await h.store.activity(h.rows[0].id)
    const group = await h.directory.getSociMembers()
    vi.spyOn(h.store, "update").mockRejectedValueOnce(new Error("Database unavailable"))
    const undo = vi.spyOn(h.directory, h.undo)
    await expect(h.run()).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(h.rows).toEqual(before)
    expect(await h.store.activity(h.rows[0].id)).toEqual(history)
    expect(await h.directory.getSociMembers()).toEqual(group)
    expect(undo).toHaveBeenCalledExactlyOnceWith(ID)
    await h.run()
    expect(h.rows[0].accountState).toBe(action === "end" ? "pending_deletion" : "active")
  })

  it.each(["end", "restore"] as const)("preserves a pre-existing mismatch after a failed %s", async (action) => {
    const h = await prepare(action)
    await h.directory[h.write](ID)
    const group = await h.directory.getSociMembers()
    vi.spyOn(h.store, "update").mockRejectedValueOnce(new Error("Database unavailable"))
    const undo = vi.spyOn(h.directory, h.undo)
    // A pre-existing mismatch has no pending write in this service instance.
    const { service } = harness({ store: h.store, directory: h.directory })
    const result = action === "end" ? service.end(ACTOR, end) : service.restore(ACTOR, restore)
    await expect(result).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" })
    expect(await h.directory.getSociMembers()).toEqual(group)
    expect(undo).not.toHaveBeenCalled()
  })

  it.each(["end", "restore"] as const)("can %s when the group already has the desired membership", async (action) => {
    const h = await prepare(action)
    await h.directory[h.write](ID)
    const write = vi.spyOn(h.directory, h.write)
    await h.run()
    expect(write).toHaveBeenCalledExactlyOnceWith(ID)
    expect((await h.service.get({ number: 1002 })).mismatch).toBeNull()
    expect(h.rows[0].accountState).toBe(action === "end" ? "pending_deletion" : "active")
  })

  it.each(["end", "restore"] as const)("surfaces a failed compensation after %s", async (action) => {
    const h = await prepare(action)
    vi.spyOn(h.store, "update").mockRejectedValueOnce(new Error("Database unavailable"))
    vi.spyOn(h.directory, h.undo).mockRejectedValueOnce(new Error("Graph unavailable"))
    await expect(h.run()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringMatching(/reconcile/i),
    })
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: ID, by: ACTOR }),
      "[soci] membership compensation failed"
    )
    expect((await h.service.get({ number: 1002 })).mismatch).toBe(action === "end" ? "not_in_soci" : "still_in_soci")
  })
})
