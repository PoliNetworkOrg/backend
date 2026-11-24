import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { Contact, PromotionContent } from "@/associations/contract"
import { createHomeService } from "@/associations/home"
import type { PromotionFilter } from "@/associations/promotions"
import type { Viewer } from "@/associations/service"
import { harness, outsider, owner, profile, promotionHarness, staff } from "./associations-fixture"

const collaborator: Viewer = { sub: "collab", name: "Collab", email: "collab@example.org", operator: false }
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
const content: PromotionContent = {
  title: "Hackathon",
  text: "Testo",
  link: "",
  poster: null,
  channels: [{ channel: "poliassociazioni", programme: null, note: "" }],
  audience: { everyone: true, programmes: [], campuses: [] },
  desiredDate: tomorrow,
  deadline: null,
  eventId: null,
}

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
  const p = promotionHarness(h)
  const home = createHomeService(
    { list: async () => structuredClone([...h.rows.values()]) },
    {
      promotions: async (filter: PromotionFilter) =>
        structuredClone(
          [...p.rows.values()].filter(
            (x) =>
              (!filter.associationId || x.associationId === filter.associationId) &&
              (!filter.status || x.status === filter.status)
          )
        ),
    }
  )
  const kinds = async (v: Viewer) => (await home.home(v)).actions.map((a) => a.kind)
  const draft = async (v: Viewer = collaborator) =>
    (await p.service.create(v, { associationId: id, content, commandId: randomUUID() })).id
  return { h, p, id, home, kinds, draft }
}

describe("Portal home", () => {
  it("shows nothing to someone with no association and no requests", async () => {
    const { home } = await setup()
    expect(await home.home(outsider)).toEqual({ operator: false, actions: [], counters: null })
  })

  it("asks the responsible to publish a registered profile and to submit drafts; the author sees their own", async () => {
    const { kinds, draft } = await setup()
    expect(await kinds(owner)).toEqual(["profile_unpublished"])
    await draft()
    expect(await kinds(owner)).toEqual(["promotion_to_submit", "profile_unpublished"])
    expect(await kinds(collaborator)).toEqual(["promotion_draft"])
  })

  it("puts requested changes first, and announces scheduled publications", async () => {
    const { p, kinds, draft, home } = await setup()
    const changes = await draft()
    await p.command(owner, changes, { action: "submit" })
    await p.command(staff, changes, { action: "changes", note: "Aggiungi il link" })
    const scheduled = await draft()
    await p.command(owner, scheduled, { action: "submit" })
    await p.command(staff, scheduled, { action: "approve", note: "" })
    await p.command(staff, scheduled, {
      action: "schedule",
      scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      channel: "poliassociazioni",
      detail: "",
      note: "",
    })
    expect(await kinds(collaborator)).toEqual(["promotion_changes", "promotion_scheduled"])
    const [first] = (await home.home(collaborator)).actions
    expect(first).toMatchObject({ targetId: changes, title: "Hackathon", urgent: true })
  })

  it("asks to confirm public contacts and to update contacts of former representatives", async () => {
    const { h, id, kinds } = await setup()
    const contact = (extra: Partial<Contact>): Contact => ({
      id: randomUUID(),
      function: "events",
      label: "Eventi",
      email: "eventi@example.org",
      name: "",
      phone: "",
      visibility: "public",
      holderSub: null,
      ...extra,
    })
    await h.command(collaborator, id, { action: "contacts", contacts: [contact({})] })
    expect(await kinds(owner)).toContain("contacts_to_publish")
    await h.command(owner, id, {
      action: "contacts",
      contacts: [contact({}), contact({ label: "Ufficio", visibility: "polinetwork", holderSub: collaborator.sub })],
    })
    await h.command(collaborator, id, { action: "leave", reason: "Graduated" })
    expect(await kinds(owner)).toContain("stale_contacts")
    expect(await kinds(collaborator)).toEqual([])
  })

  it("tells an applicant when PoliNetwork asks for more information", async () => {
    const { h, home } = await setup()
    const applicant: Viewer = { sub: "applicant", name: "Applicant", operator: false }
    const { id } = await h.service.create(applicant, {
      profile: { ...profile, name: "New" },
      explanation: "Founder",
      submit: true,
      commandId: randomUUID(),
    })
    await h.command(staff, id, {
      action: "review",
      requestId: h.rows.get(id)?.requests[0].id ?? "",
      decision: "changes",
      reason: "Add the statute",
    })
    expect((await home.home(applicant)).actions).toMatchObject([{ kind: "request_changes", associationName: "New" }])
  })

  it("gives operators the queue counters", async () => {
    const { p, h, id, draft, home } = await setup()
    await p.command(owner, await draft(), { action: "submit" })
    await h.command(owner, id, { action: "save", requestId: null, profile, explanation: "Publish" })
    await h.command(owner, id, { action: "submit", requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "" })
    await h.command(outsider, id, { action: "access", explanation: "Member" })
    expect((await home.home(staff)).counters).toEqual({
      profiles: 1,
      access: 1,
      promotions: 1,
      events: 0,
      handovers: 0,
    })
    expect((await home.home(owner)).counters).toBeNull()
  })
})
