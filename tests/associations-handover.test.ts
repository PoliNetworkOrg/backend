import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Contact } from "@/associations/contract"
import { createHomeService } from "@/associations/home"
import type { Viewer } from "@/associations/service"
import { harness, outsider, owner, staff } from "./associations-fixture"

const successor: Viewer = { sub: "next", name: "Next", email: "next@example.org", operator: false }
const personal = (extra: Partial<Contact> = {}): Contact => ({
  id: randomUUID(),
  function: "presidency",
  label: "Presidente",
  email: "presidente@example.org",
  name: "Owner",
  phone: "+39 333 000 0000",
  visibility: "polinetwork",
  holderSub: owner.sub,
  ...extra,
})

async function setup() {
  const h = harness()
  const id = await h.registered()
  const contact = personal()
  await h.command(owner, id, {
    action: "contacts",
    contacts: [contact, personal({ name: "", phone: "", holderSub: null, label: "Generico" })],
  })
  const home = createHomeService(
    { list: async () => structuredClone([...h.rows.values()]) },
    { promotions: async () => [] }
  )
  return { h, id, contact, home }
}
async function approveSuccessor(h: Awaited<ReturnType<typeof setup>>["h"], id: string) {
  await h.command(owner, id, {
    action: "invite",
    email: "next@example.org",
    role: "responsible",
    explanation: "Nuovo presidente",
  })
  const token = h.mails.at(-1)?.text.split("token=")[1] ?? ""
  await h.service.accept(successor, token)
  await h.command(staff, id, {
    action: "review",
    requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "",
    decision: "approve",
    reason: "OK",
  })
}

describe("Guided handover", () => {
  it("walks the outgoing responsible through successor, contacts and completion", async () => {
    const { h, id, contact, home } = await setup()
    await expect(h.command(outsider, id, { action: "handoverStart" })).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.command(owner, id, { action: "handoverStart" })
    await expect(h.command(owner, id, { action: "handoverStart" })).rejects.toMatchObject({ code: "CONFLICT" })
    let state = (await h.service.get(owner, id)).handoverState
    expect(state).toMatchObject({ successorReady: false, contactsToReview: [contact.id], startedByName: "Owner" })
    expect((await home.home(owner)).actions[0]).toMatchObject({ kind: "handover_open", urgent: true })
    expect((await home.home(staff)).counters?.handovers).toBe(1)
    await expect(h.command(owner, id, { action: "handoverComplete", leave: true })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await approveSuccessor(h, id)
    expect((await h.service.get(successor, id)).handoverState?.successorReady).toBe(true)
    // The successor sees it but only the outgoing responsible runs it.
    await expect(h.command(successor, id, { action: "handoverComplete", leave: false })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await expect(h.command(owner, id, { action: "handoverComplete", leave: true })).rejects.toMatchObject({
      message: "Review the personal contacts before completing the handover",
    })
    await expect(h.command(owner, id, { action: "handoverConfirm", contactIds: [randomUUID()] })).rejects.toMatchObject(
      { code: "BAD_REQUEST" }
    )
    await h.command(owner, id, { action: "handoverConfirm", contactIds: [contact.id] })
    state = (await h.service.get(owner, id)).handoverState
    expect(state?.contactsToReview).toEqual([])
    await h.command(owner, id, { action: "handoverComplete", leave: true })
    const after = await h.service.get(successor, id)
    expect(after.handoverState).toBeNull()
    expect(after.members.find((m) => m.sub === owner.sub)?.active).toBe(false)
    // The successor inherits the history and the flagged contacts.
    expect(after.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "Handover started",
        "Handover contacts reviewed",
        "Handover completed",
        "Contacts to update",
      ])
    )
    expect(after.staleContacts).toEqual([contact.id])
    expect((await home.home(staff)).counters?.handovers).toBe(0)
  })

  it("closes when the outgoing responsible leaves, and lets PoliNetwork cancel a stalled one", async () => {
    const { h, id } = await setup()
    await approveSuccessor(h, id)
    await h.command(owner, id, { action: "handoverStart" })
    await h.command(owner, id, { action: "leave", reason: "Laureato" })
    expect((await h.service.get(successor, id)).handoverState).toBeNull()
    await h.command(successor, id, { action: "handoverStart" })
    await h.command(staff, id, { action: "handoverCancel" })
    expect((await h.service.get(successor, id)).handoverState).toBeNull()
  })

  it("is visible only to representatives and operators", async () => {
    const { h, id } = await setup()
    await h.command(owner, id, { action: "handoverStart" })
    expect((await h.service.list(staff)).associations[0].handover).toBe(true)
    await h.command(outsider, id, { action: "access", explanation: "Me" })
    const view = await h.service.get(outsider, id)
    expect(view.handoverState).toBeNull()
    expect(view.handover).toBe(false)
  })
})
