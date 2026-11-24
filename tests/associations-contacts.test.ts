import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Contact } from "@/associations/contract"
import { normalizeRecord, type Record, type Viewer } from "@/associations/service"
import { harness, outsider, owner, profile, programme, staff } from "./associations-fixture"

const other: Viewer = { sub: "other", name: "Other", email: "other@example.org", operator: false }
const collaborator: Viewer = { sub: "collab", name: "Collab", email: "collab@example.org", operator: false }
const contact = (visibility: Contact["visibility"], extra: Partial<Contact> = {}): Contact => ({
  id: randomUUID(),
  function: "events",
  label: `Eventi ${visibility}`,
  email: `${visibility}@example.org`,
  name: "",
  phone: "",
  visibility,
  holderSub: null,
  ...extra,
})

async function setup() {
  const h = harness()
  const id = await h.registered()
  // A second, unrelated active association whose responsible is `other`.
  const { id: second } = await h.service.create(other, {
    profile: { ...profile, name: "Second" },
    explanation: "I represent it",
    submit: true,
    commandId: randomUUID(),
  })
  await h.command(staff, second, {
    action: "review",
    requestId: h.rows.get(second)!.requests[0].id,
    decision: "approve",
    reason: "Verified",
  })
  // Add a collaborator to the first association through an approved access request.
  await h.command(collaborator, id, { action: "access", explanation: "Member of the board" })
  await h.command(staff, id, {
    action: "review",
    requestId: h.rows.get(id)!.requests.at(-1)!.id,
    decision: "approve",
    reason: "OK",
  })
  h.rows.get(id)!.members.find((m) => m.sub === collaborator.sub)!.role = "collaborator"
  return { h, id, second }
}

describe("Programme and campus catalogue", () => {
  it("shows retired entries only to operators and lets only operators edit it", async () => {
    const h = harness()
    expect((await h.service.catalogue(owner)).some((e) => !e.active)).toBe(false)
    expect((await h.service.catalogue(staff)).some((e) => !e.active)).toBe(true)
    const entry = { kind: "campus" as const, slug: "piacenza", nameIt: "Piacenza", nameEn: "Piacenza", active: true }
    await expect(h.service.saveCatalogue(owner, entry)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await h.service.saveCatalogue(staff, entry)
    expect((await h.service.catalogue(owner)).map((e) => e.slug)).toContain("piacenza")
  })
  it("accepts only catalogue entries in the profile, with cross-programme excluding programmes", async () => {
    const h = harness()
    const id = await h.registered()
    const save = (p: Partial<typeof profile>) =>
      h.command(owner, id, { action: "save", requestId: null, profile: { ...profile, ...p }, explanation: "Edit" })
    await expect(save({ programmes: ["didattica.x.triennale.unknown"] })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(save({ programmes: ["didattica.design.triennale.design-della-moda"] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
    await expect(save({ crossProgramme: true, programmes: [programme] })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await expect(save({ campuses: ["leonardo", "leonardo"] })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await save({ programmes: [programme], campuses: ["leonardo", "bovisa"] })
    const q = h.rows.get(id)!.requests.at(-1)!
    await h.command(owner, id, { action: "submit", requestId: q.id })
    await h.command(staff, id, { action: "review", requestId: q.id, decision: "approve", reason: "OK" })
    expect((await h.service.get(outsider, id).catch(() => null)) ?? null).toBeNull()
    expect((await h.service.directory(outsider)).find((r) => r.id === id)).toMatchObject({
      programmes: [programme],
      campuses: ["leonardo", "bovisa"],
    })
  })
  it("keeps a retired entry already on the profile but refuses to add it again elsewhere", async () => {
    const h = harness()
    const id = await h.registered()
    await h.command(owner, id, {
      action: "save",
      requestId: null,
      profile: { ...profile, programmes: [programme] },
      explanation: "Edit",
    })
    const q = h.rows.get(id)!.requests.at(-1)!
    await h.command(owner, id, { action: "submit", requestId: q.id })
    await h.command(staff, id, { action: "review", requestId: q.id, decision: "approve", reason: "OK" })
    await h.service.saveCatalogue(staff, { ...h.catalogue.find((e) => e.slug === programme)!, active: false })
    await h.command(owner, id, {
      action: "save",
      requestId: null,
      profile: { ...profile, programmes: [programme], descriptionIt: "Nuova" },
      explanation: "Still listed",
    })
    const other = await h.registered()
    await expect(
      h.command(owner, other, {
        action: "save",
        requestId: null,
        profile: { ...profile, programmes: [programme] },
        explanation: "New",
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })
})

describe("Contacts", () => {
  it("saves non-public contacts at once, records them in the history without personal data", async () => {
    const { h, id } = await setup()
    const hidden = contact("polinetwork", { name: "Maria Rossi", phone: "+39 333 1234567" })
    await h.command(collaborator, id, { action: "contacts", contacts: [hidden] })
    const detail = await h.service.get(collaborator, id)
    expect(detail.contacts).toEqual([hidden])
    expect(detail.requests.filter((q) => q.status === "draft")).toEqual([])
    const history = detail.events.find((e) => e.action === "Contacts updated")!
    expect(history.detail).toContain(hidden.label)
    expect(history.detail).not.toContain("Maria")
    expect(history.detail).not.toContain("333")
  })
  it("puts public contacts into the working profile, which only the responsible submits for review", async () => {
    const { h, id } = await setup()
    const shown = contact("public")
    await h.command(collaborator, id, { action: "contacts", contacts: [shown] })
    const draft = h.rows.get(id)!.requests.at(-1)!
    expect(draft).toMatchObject({ kind: "content", status: "draft" })
    expect(draft.profile!.contacts).toEqual([shown])
    expect((await h.service.directory(outsider)).find((r) => r.id === id)!.contacts).toEqual([])
    await expect(h.command(collaborator, id, { action: "submit", requestId: draft.id })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await h.command(owner, id, { action: "submit", requestId: draft.id })
    await expect(h.command(collaborator, id, { action: "contacts", contacts: [] })).rejects.toMatchObject({
      code: "CONFLICT",
    })
    await h.command(staff, id, { action: "review", requestId: draft.id, decision: "approve", reason: "OK" })
    expect((await h.service.get(owner, id)).publishedProfile!.contacts).toEqual([shown])
    expect((await h.service.directory(outsider)).find((r) => r.id === id)!.contacts).toEqual([shown])
  })
  it("filters the directory by who is asking", async () => {
    const { h, id } = await setup()
    const shown = contact("public")
    const shared = contact("associations")
    const internal = contact("polinetwork")
    await h.command(owner, id, { action: "contacts", contacts: [shown, shared, internal] })
    const draft = h.rows.get(id)!.requests.at(-1)!
    await h.command(owner, id, { action: "submit", requestId: draft.id })
    await h.command(staff, id, { action: "review", requestId: draft.id, decision: "approve", reason: "OK" })
    const seen = async (v: Viewer) =>
      (await h.service.directory(v))
        .find((r) => r.id === id)!
        .contacts.map((c) => c.visibility)
        .sort()
    expect(await seen(outsider)).toEqual(["public"])
    expect(await seen(other)).toEqual(["associations", "public"])
    expect(await seen(collaborator)).toEqual(["associations", "polinetwork", "public"])
    expect(await seen(staff)).toEqual(["associations", "polinetwork", "public"])
    // Representatives of a suspended association lose the shared view.
    const second = (await h.service.list(other)).associations[0].id
    await h.command(staff, second, { action: "status", status: "suspended", hide: false, reason: "Check" })
    expect(await seen(other)).toEqual(["public"])
    expect((await h.service.get(outsider, id).catch((e) => e)).code).toBe("NOT_FOUND")
  })
  it("flags the contacts linked to a representative who loses access", async () => {
    const { h, id } = await setup()
    const linked = contact("associations", { name: "Collab", holderSub: collaborator.sub })
    await h.command(owner, id, { action: "contacts", contacts: [linked] })
    await expect(
      h.command(owner, id, { action: "contacts", contacts: [contact("polinetwork", { holderSub: "stranger" })] })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    expect((await h.service.get(owner, id)).staleContacts).toEqual([])
    await h.command(collaborator, id, { action: "leave", reason: "Graduated" })
    const detail = await h.service.get(owner, id)
    expect(detail.staleContacts).toEqual([linked.id])
    expect(detail.events.at(-1)).toMatchObject({ action: "Contacts to update", detail: linked.label })
    // A former representative keeps only their own requests: no contacts, no edits.
    expect(await h.service.get(collaborator, id)).toMatchObject({ contacts: [], staleContacts: [], canEdit: false })
  })
  it("reads records written before programmes, campuses and contacts existed", () => {
    const legacy = {
      profile: { name: "Old", acronym: "", descriptionIt: "", descriptionEn: "", logo: null, email: "", links: [] },
      published: null,
      requests: [{ profile: { name: "Old", links: [] } }, { profile: null }],
    } as unknown as Record
    const r = normalizeRecord(legacy)
    expect(r.profile).toMatchObject({ programmes: [], campuses: [], crossProgramme: false, contacts: [] })
    expect(r.requests[0].profile).toMatchObject({ contacts: [] })
    expect(r.contacts).toEqual([])
  })
})
