import { randomUUID } from "node:crypto"
import { createElement } from "react"
import { describe, expect, it } from "vitest"
import type { PromotionContent } from "@/associations/contract"
import type { Viewer } from "@/associations/service"
import { renderEmail } from "@/emails/render"
import AssociationPromotionEmail from "@/emails/templates/association-promotion"
import { harness, outsider, owner, programme, promotionHarness, staff } from "./associations-fixture"

const collaborator: Viewer = { sub: "collab", name: "Collab", email: "collab@example.org", operator: false }
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
const content = (extra: Partial<PromotionContent> = {}): PromotionContent => ({
  title: "Hackathon",
  text: "Ventiquattro ore di progetti.",
  link: "https://example.org/hackathon",
  poster: null,
  channels: [{ channel: "poliassociazioni", programme: null, note: "" }],
  audience: { everyone: true, programmes: [], campuses: [] },
  desiredDate: tomorrow,
  deadline: null,
  eventId: null,
  ...extra,
})

async function setup() {
  const h = harness()
  const id = await h.registered()
  await h.command(collaborator, id, { action: "access", explanation: "Board member" })
  await h.command(staff, id, {
    action: "review",
    requestId: h.rows.get(id)?.requests.at(-1)?.id ?? "",
    decision: "approve",
    reason: "OK",
  })
  const member = h.rows.get(id)?.members.find((m) => m.sub === collaborator.sub)
  if (member) member.role = "collaborator"
  const p = promotionHarness(h)
  const draft = async (v: Viewer = collaborator, c = content()) =>
    (await p.service.create(v, { associationId: id, content: c, commandId: randomUUID() })).id
  return { h, p, id, draft }
}

describe("Promotion requests", () => {
  it("lets representatives prepare drafts and only the responsible submit", async () => {
    const { p, id, draft } = await setup()
    await expect(
      p.service.create(outsider, { associationId: id, content: content(), commandId: randomUUID() })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      p.service.create(staff, { associationId: id, content: content(), commandId: randomUUID() })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    const pid = await draft()
    expect(await p.service.get(collaborator, pid)).toMatchObject({ status: "draft", canEdit: true, canSubmit: false })
    await expect(p.command(collaborator, pid, { action: "submit" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    await p.command(owner, pid, { action: "submit" })
    const submitted = await p.service.get(owner, pid)
    expect(submitted).toMatchObject({ status: "submitted", canEdit: false })
    expect(submitted.transitions.map((t) => [t.from, t.to, t.actorName])).toEqual([
      [null, "draft", "Collab"],
      ["draft", "submitted", "Owner"],
    ])
    // The author and the submitter both hear about it, through the templated outbox.
    expect(p.mails.map((m) => m.to).sort()).toEqual(["collab@example.org", "owner@example.org"])
    expect(p.mails[0].template?.kind).toBe("association-promotion")
  })

  it("refuses incomplete requests on submit and checks catalogue entries", async () => {
    const { p, draft } = await setup()
    const incomplete = await draft(collaborator, content({ title: "", desiredDate: null }))
    await expect(p.command(owner, incomplete, { action: "submit" })).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const course = await draft(
      collaborator,
      content({ channels: [{ channel: "course_broadcast", programme: null, note: "" }] })
    )
    await expect(p.command(owner, course, { action: "submit" })).rejects.toMatchObject({
      message: "Choose the degree programme for each course channel",
    })
    await expect(
      draft(collaborator, content({ audience: { everyone: false, programmes: ["didattica.unknown"], campuses: [] } }))
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
    const ok = await draft(
      collaborator,
      content({
        channels: [{ channel: "course_broadcast", programme, note: "" }],
        audience: { everyone: false, programmes: [programme], campuses: ["leonardo"] },
      })
    )
    await p.command(owner, ok, { action: "submit" })
    expect((await p.service.get(owner, ok)).status).toBe("submitted")
  })

  it("follows the operator lifecycle, recording who moved it and when", async () => {
    const { p, draft } = await setup()
    const pid = await draft()
    await p.command(owner, pid, { action: "submit" })
    await expect(p.command(owner, pid, { action: "approve", note: "", cost: null })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await p.command(staff, pid, { action: "changes", note: "Aggiungi il link al modulo" })
    expect(await p.service.get(collaborator, pid)).toMatchObject({ status: "changes_requested", canEdit: true })
    await p.command(collaborator, pid, { action: "save", content: content({ link: "https://example.org/form" }) })
    await p.command(owner, pid, { action: "submit" })
    await expect(
      p.command(staff, pid, {
        action: "schedule",
        scheduledAt: `${tomorrow}T10:00:00+01:00`,
        channel: "poliassociazioni",
        detail: "",
        note: "",
      })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    await p.command(staff, pid, { action: "approve", note: "", cost: null })
    await p.command(staff, pid, {
      action: "schedule",
      scheduledAt: `${tomorrow}T10:00:00+01:00`,
      channel: "poliassociazioni",
      detail: "Post del mattino",
      note: "",
    })
    await p.command(staff, pid, { action: "publish", url: "https://t.me/poliassociazioni/1", note: "" })
    const done = await p.service.get(owner, pid)
    expect(done).toMatchObject({
      status: "published",
      publishedUrl: "https://t.me/poliassociazioni/1",
      scheduledChannel: "poliassociazioni",
      canWithdraw: false,
    })
    expect(done.transitions.map((t) => t.to)).toEqual([
      "draft",
      "submitted",
      "changes_requested",
      "submitted",
      "approved",
      "scheduled",
      "published",
    ])
    expect(done.transitions.every((t) => t.at && t.actorName)).toBe(true)
    // Every transition sends mail: two addresses for each of the six moves after the draft.
    expect(p.mails.length).toBe(12)
  })

  it("keeps operator notes from representatives and mails only public comments", async () => {
    const { p, draft } = await setup()
    const pid = await draft()
    await p.command(owner, pid, { action: "submit" })
    const before = p.mails.length
    await p.command(staff, pid, { action: "comment", note: "Verificare con il direttivo", internal: true })
    expect(p.mails.length).toBe(before)
    await p.command(staff, pid, { action: "comment", note: "Ottima iniziativa", internal: false })
    expect(p.mails.length).toBe(before + 2)
    await p.command(collaborator, pid, { action: "comment", note: "Grazie", internal: true })
    const seen = await p.service.get(collaborator, pid)
    expect(seen.transitions.map((t) => t.note)).not.toContain("Verificare con il direttivo")
    expect(seen.transitions.map((t) => t.note)).toContain("Ottima iniziativa")
    // A representative cannot mark a comment internal.
    expect(seen.transitions.find((t) => t.note === "Grazie")?.internal).toBe(false)
    expect((await p.service.get(staff, pid)).transitions.map((t) => t.note)).toContain("Verificare con il direttivo")
  })

  it("lets rejection and withdrawal close a request even after approval", async () => {
    const { p, draft } = await setup()
    const a = await draft()
    await p.command(owner, a, { action: "submit" })
    await p.command(staff, a, { action: "approve", note: "", cost: null })
    await expect(p.command(collaborator, a, { action: "withdraw", note: "" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
    await p.command(owner, a, { action: "withdraw", note: "Evento annullato" })
    expect((await p.service.get(owner, a)).status).toBe("withdrawn")
    const b = await draft()
    await p.command(owner, b, { action: "submit" })
    await p.command(staff, b, { action: "approve", note: "", cost: null })
    await p.command(staff, b, { action: "reject", note: "Contenuto non conforme" })
    expect((await p.service.get(owner, b)).status).toBe("rejected")
    await expect(p.command(owner, b, { action: "withdraw", note: "" })).rejects.toMatchObject({ code: "FORBIDDEN" })
    // An author may drop their own draft.
    const c = await draft()
    await p.command(collaborator, c, { action: "withdraw", note: "" })
    expect((await p.service.get(owner, c)).status).toBe("withdrawn")
  })

  it("rejects stale revisions and replays retried commands once", async () => {
    const { p, draft } = await setup()
    const pid = await draft()
    const submit = {
      id: pid,
      revision: p.rows.get(pid)?.revision ?? 0,
      commandId: randomUUID(),
      action: "submit" as const,
    }
    await p.service.command(owner, submit)
    await p.service.command(owner, submit)
    expect(p.rows.get(pid)?.transitions.filter((t) => t.to === "submitted")).toHaveLength(1)
    await expect(
      p.service.command(staff, { ...submit, commandId: randomUUID(), action: "approve", note: "", cost: null })
    ).rejects.toMatchObject({ code: "CONFLICT" })
    const key = randomUUID()
    const first = await p.service.create(collaborator, {
      associationId: (await p.service.get(owner, pid)).associationId,
      content: content(),
      commandId: key,
    })
    const again = await p.service.create(collaborator, {
      associationId: (await p.service.get(owner, pid)).associationId,
      content: content(),
      commandId: key,
    })
    expect(again.id).toBe(first.id)
  })

  it("hides requests from anyone outside the association, including former representatives", async () => {
    const { h, p, id, draft } = await setup()
    const pid = await draft()
    await expect(p.service.get(outsider, pid)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(p.service.list(outsider, id)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await h.command(collaborator, id, { action: "leave", reason: "Graduated" })
    await expect(p.service.get(collaborator, pid)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(p.command(collaborator, pid, { action: "save", content: content() })).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
  })

  it("gives operators a queue filtered by status and date", async () => {
    const { p, draft } = await setup()
    await expect(p.service.queue(owner, {})).rejects.toMatchObject({ code: "FORBIDDEN" })
    const later = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10)
    const a = await draft()
    const b = await draft(collaborator, content({ desiredDate: later }))
    await p.command(owner, a, { action: "submit" })
    await p.command(owner, b, { action: "submit" })
    expect((await p.service.queue(staff, { status: "submitted" })).map((q) => q.id).sort()).toEqual([a, b].sort())
    expect((await p.service.queue(staff, { status: "submitted", to: tomorrow })).map((q) => q.id)).toEqual([a])
    expect((await p.service.queue(staff, { from: later })).map((q) => q.id)).toEqual([b])
    expect((await p.service.queue(staff, { status: "draft" })).length).toBe(0)
    expect((await p.service.queue(staff, {}))[0].associationName).toBe("Association")
  })

  it("renders the promotion email", async () => {
    const props = AssociationPromotionEmail.PreviewProps
    if (!props) throw new Error("missing preview props")
    const { html, text } = await renderEmail(createElement(AssociationPromotionEmail, props))
    expect(html).toContain("Richiesta di promozione")
    expect(text).toContain("Aggiungi il link al modulo di iscrizione.")
  })
})
