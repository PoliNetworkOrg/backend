import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { CalendarEventContent, Contact } from "@/associations/contract"
import { createHomeService } from "@/associations/home"
import { publicEvents } from "@/associations/public"
import type { Viewer } from "@/associations/service"
import { eventHarness, harness, outsider, owner, profile, promotionHarness, staff } from "./associations-fixture"

const collaborator: Viewer = { sub: "collab", name: "Collab", email: "collab@example.org", operator: false }
const other: Viewer = { sub: "other", name: "Other", email: "other@example.org", operator: false }
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString()
const content = (extra: Partial<CalendarEventContent> = {}): CalendarEventContent => ({
  title: "Serata giochi",
  descriptionIt: "Giochi da tavolo",
  descriptionEn: "Board games",
  startsAt: inDays(3),
  endsAt: null,
  online: false,
  venue: "Aula studio, edificio 3",
  campus: "leonardo",
  link: "",
  poster: null,
  ...extra,
})

async function setup() {
  const h = harness()
  const id = await h.registered()
  await h.command(collaborator, id, { action: "access", explanation: "Board" })
  await h.command(staff, id, {
    action: "review",
    requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "",
    decision: "approve",
    reason: "OK",
  })
  const member = h.rows.get(id)?.members.find((m) => m.sub === collaborator.sub)
  if (member) member.role = "collaborator"
  // Publish the profile so the association is on the website.
  await h.command(owner, id, { action: "save", requestId: null, profile, explanation: "Publish" })
  await h.command(owner, id, { action: "submit", requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "" })
  await h.command(staff, id, {
    action: "review",
    requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "",
    decision: "approve",
    reason: "OK",
  })
  const record = h.rows.get(id)
  if (record) record.legacyId = 7
  const ev = eventHarness(h)
  const draft = async (c = content(), v: Viewer = collaborator) =>
    (await ev.service.create(v, { associationId: id, content: c, commandId: randomUUID() })).id
  const site = () =>
    publicEvents(
      { published: async () => [...h.rows.values()].filter((r) => r.published), catalogue: async () => h.catalogue },
      ev.store
    )
  return { h, id, ev, draft, site }
}

describe("Calendar events", () => {
  it("become public only after an operator approves them", async () => {
    const { ev, draft, site } = await setup()
    const eid = await draft()
    await expect(ev.command(collaborator, eid, { action: "submit" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await ev.command(owner, eid, { action: "submit" })
    expect(await site()).toEqual([])
    await expect(ev.command(owner, eid, { action: "approve", note: "" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await ev.command(staff, eid, { action: "changes", note: "Aggiungi l’orario di fine" })
    await ev.command(collaborator, eid, { action: "save", content: content({ endsAt: inDays(3.1) }) })
    await ev.command(owner, eid, { action: "submit" })
    await ev.command(staff, eid, { action: "approve", note: "" })
    const [listed] = await site()
    expect(listed).toMatchObject({
      id: eid,
      associationId: 7,
      associationName: "Association",
      title: "Serata giochi",
      campus: { slug: "leonardo", nameIt: "Milano Leonardo" },
    })
    expect(Object.keys(listed)).not.toContain("notify")
    // The responsible can take an approved event off the calendar.
    await ev.command(owner, eid, { action: "withdraw", note: "Annullato" })
    expect(await site()).toEqual([])
    expect(ev.mails.every((m) => m.template?.kind === "association-event")).toBe(true)
  })

  it("checks completeness on submit and hides past events", async () => {
    const { ev, draft, site } = await setup()
    for (const incomplete of [
      content({ descriptionEn: "" }),
      content({ startsAt: null }),
      content({ online: false, venue: "" }),
      content({ startsAt: inDays(-1) }),
    ]) {
      const eid = await draft(incomplete)
      await expect(ev.command(owner, eid, { action: "submit" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    }
    await expect(draft(content({ endsAt: inDays(1) }))).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const online = await draft(content({ online: true, venue: "", campus: null }))
    await ev.command(owner, online, { action: "submit" })
    await ev.command(staff, online, { action: "approve", note: "" })
    expect((await site()).map((e) => e.online)).toEqual([true])
    // Once it is over, it leaves the calendar.
    const stored = ev.rows.get(online)
    if (stored) stored.content.startsAt = inDays(-3)
    expect(await site()).toEqual([])
  })

  it("keeps events from outsiders and internal notes from representatives", async () => {
    const { ev, id, draft } = await setup()
    const eid = await draft()
    await expect(ev.service.get(outsider, eid)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(ev.service.list(outsider, id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await ev.command(staff, eid, { action: "comment", note: "Interno", internal: true })
    expect((await ev.service.get(collaborator, eid)).transitions.map((t) => t.note)).not.toContain("Interno")
    await expect(ev.service.queue(owner, {})).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("lets a promotion request reference only the association's own events", async () => {
    const { h, id, ev, draft } = await setup()
    const eid = await draft()
    const { service } = promotionHarness(h, async (x) => (await ev.store.event(x))?.associationId ?? null)
    const promotionContent = {
      title: "Serata giochi",
      text: "Testo",
      link: "",
      poster: null,
      channels: [{ channel: "poliassociazioni" as const, programme: null, note: "" }],
      audience: { everyone: true, programmes: [], campuses: [] },
      desiredDate: inDays(2).slice(0, 10),
      deadline: null,
      eventId: eid,
    }
    await service.create(collaborator, { associationId: id, content: promotionContent, commandId: randomUUID() })
    await expect(
      service.create(collaborator, {
        associationId: id,
        content: { ...promotionContent, eventId: randomUUID() },
        commandId: randomUUID(),
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })
})

describe("Collaborations", () => {
  it("shows the open flag to everyone and the dedicated contact only to who may see it", async () => {
    const { h, id } = await setup()
    const shared: Contact = {
      id: randomUUID(),
      function: "collaborations",
      label: "Collaborazioni",
      email: "collab@example.org",
      name: "",
      phone: "",
      visibility: "associations",
      holderSub: null,
    }
    await h.command(collaborator, id, { action: "contacts", contacts: [shared] })
    await expect(
      h.command(collaborator, id, { action: "collaboration", open: true, contactId: randomUUID() })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    await h.command(collaborator, id, { action: "collaboration", open: true, contactId: shared.id })
    const { id: second } = await h.service.create(other, {
      profile: { ...profile, name: "Second" },
      explanation: "Founder",
      submit: true,
      commandId: randomUUID(),
    })
    await h.command(staff, second, {
      action: "review",
      requestId: h.rows.get(second)?.requests[0].id ?? "",
      decision: "approve",
      reason: "OK",
    })
    const entry = async (v: Viewer) => (await h.service.directory(v)).find((r) => r.id === id)?.collaboration
    expect(await entry(outsider)).toEqual({ open: true, contactId: null })
    expect(await entry(other)).toEqual({ open: true, contactId: shared.id })
    expect((await h.service.get(owner, id)).events.at(-1)?.action).toBe("Open to collaborations")
    await h.command(owner, id, { action: "collaboration", open: false, contactId: shared.id })
    expect(await entry(other)).toEqual({ open: false, contactId: null })
  })
})

describe("Home with events", () => {
  it("lists event steps and counts submitted events for operators", async () => {
    const { h, ev, draft } = await setup()
    const changes = await draft()
    await ev.command(owner, changes, { action: "submit" })
    await ev.command(staff, changes, { action: "changes", note: "Aggiungi la sede" })
    const waiting = await draft()
    await ev.command(owner, waiting, { action: "submit" })
    await draft()
    const home = createHomeService(
      { list: async () => structuredClone([...h.rows.values()]) },
      { promotions: async () => [] },
      ev.store
    )
    expect((await home.home(collaborator)).actions.map((a) => a.kind)).toEqual(["event_changes", "event_draft"])
    expect((await home.home(owner)).actions.map((a) => a.kind)).toEqual(["event_changes", "event_to_submit"])
    expect((await home.home(staff)).counters?.events).toBe(1)
  })
})
