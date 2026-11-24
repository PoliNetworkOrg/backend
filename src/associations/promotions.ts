import { randomUUID } from "node:crypto"
import type { z } from "zod"
import {
  type CatalogueEntry,
  type PromotionCommand,
  type PromotionContent,
  type PromotionStatus,
  type PromotionTransition,
  programmeChannels,
  type promotionCreateSchema,
  type promotionQueueSchema,
} from "./contract"
import { type Ledger, settle } from "./credits"
import { activeMember, fail, type Mail, type Record, type Viewer } from "./service"

/** A promotion request as stored: one row per request plus its append-only transitions. */
export type Promotion = {
  id: string
  associationId: string
  status: PromotionStatus
  revision: number
  content: PromotionContent
  createdBy: string
  createdByName: string
  /** Who hears about every transition: the author and whoever submitted it. Never shown in responses. */
  notify: string[]
  createdAt: string
  updatedAt: string
  scheduledAt: string | null
  scheduledChannel: PromotionContent["channels"][number]["channel"] | null
  scheduledDetail: string
  publishedUrl: string | null
  publishedAt: string | null
  transitions: (PromotionTransition & { actorSub: string })[]
}
export type PromotionFilter = z.infer<typeof promotionQueueSchema> & { associationId?: string }
export type PromotionStore = {
  promotions(filter: PromotionFilter): Promise<Promotion[]>
  promotion(id: string): Promise<Promotion | null>
  /**
   * Locks the association (shared, so a revocation waits) and inserts what `operation` builds, unless `key` was used
   * before: then it returns the id that key produced. `Promotion.transitions` are inserted with the row.
   */
  createPromotion(
    associationId: string,
    key: string,
    operation: (record: Record, mail: Mail[]) => Promotion
  ): Promise<string>
  /**
   * Locks the association (shared) and the promotion (exclusive), runs `operation`, stores the row, inserts the new
   * transitions and the mail, and records `key`. A replayed key returns the stored id without running `operation`.
   */
  /** `ledger` is the association's credit ledger, locked for this operation (debits on approval, reversals). */
  changePromotion(
    id: string,
    key: string,
    operation: (promotion: Promotion, record: Record, mail: Mail[], ledger: Ledger) => void
  ): Promise<string>
}

const OPEN: PromotionStatus[] = ["draft", "submitted", "changes_requested", "approved", "scheduled"]
export const promotionStatusLabel = {
  draft: "Bozza",
  submitted: "In revisione",
  changes_requested: "Modifiche richieste",
  approved: "Approvata",
  scheduled: "Programmata",
  published: "Pubblicata",
  rejected: "Respinta",
  withdrawn: "Ritirata",
} satisfies { [S in PromotionStatus]: string }

// Representatives act only through an active association; operators never act as one.
const member = (r: Record, v: Viewer) => r.status === "active" && !!activeMember(r, v)
const responsibleMember = (r: Record, v: Viewer) => r.status === "active" && activeMember(r, v)?.role === "responsible"
const readable = (r: Record, v: Viewer) => v.operator || !!activeMember(r, v)

function checkContent(content: PromotionContent, catalogue: CatalogueEntry[], complete: boolean) {
  const known = (kind: CatalogueEntry["kind"], slug: string) =>
    catalogue.some((e) => e.kind === kind && e.slug === slug && e.active)
  for (const c of content.channels) {
    if (c.programme && !known("programme", c.programme)) fail("BAD_REQUEST", "Choose programmes from the catalogue")
    if (complete && programmeChannels.includes(c.channel) && !c.programme)
      fail("BAD_REQUEST", "Choose the degree programme for each course channel")
  }
  for (const slug of content.audience.programmes)
    if (!known("programme", slug)) fail("BAD_REQUEST", "Choose programmes from the catalogue")
  for (const slug of content.audience.campuses)
    if (!known("campus", slug)) fail("BAD_REQUEST", "Choose campuses from the catalogue")
  if (!complete) return
  if (!content.title || !content.text) fail("BAD_REQUEST", "Add a title and a text before submitting")
  if (!content.channels.length) fail("BAD_REQUEST", "Choose at least one channel")
  if (!content.audience.everyone && !content.audience.programmes.length && !content.audience.campuses.length)
    fail("BAD_REQUEST", "Choose the audience: everyone, or programmes or campuses")
  if (!content.desiredDate) fail("BAD_REQUEST", "Choose the desired date")
  if (content.desiredDate < new Date().toISOString().slice(0, 10)) fail("BAD_REQUEST", "The desired date has passed")
  if (content.deadline && content.deadline < content.desiredDate)
    fail("BAD_REQUEST", "The deadline cannot come before the desired date")
}

function transition(
  p: Promotion,
  v: Viewer,
  to: PromotionStatus | null,
  note = "",
  internal = false
): PromotionTransition & { actorSub: string } {
  return {
    id: randomUUID(),
    kind: to ? "transition" : "comment",
    from: to ? p.status : null,
    to,
    at: new Date().toISOString(),
    actorSub: v.sub,
    actorName: v.name,
    note,
    internal,
  }
}

/** The response for this viewer: operator notes and notification addresses stay on the server. */
export function presentPromotion(p: Promotion, r: Record, v: Viewer) {
  if (!readable(r, v)) fail("NOT_FOUND", "Promotion request not found")
  const editable = ["draft", "changes_requested"].includes(p.status)
  return {
    id: p.id,
    associationId: p.associationId,
    associationName: r.profile.name,
    status: p.status,
    revision: p.revision,
    content: p.content,
    createdByName: p.createdByName,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    scheduledAt: p.scheduledAt,
    scheduledChannel: p.scheduledChannel,
    scheduledDetail: p.scheduledDetail,
    publishedUrl: p.publishedUrl,
    publishedAt: p.publishedAt,
    transitions: p.transitions
      .filter((t) => v.operator || !t.internal)
      .map((t) => ({
        id: t.id,
        kind: t.kind,
        from: t.from,
        to: t.to,
        at: t.at,
        actorName: t.actorName,
        note: t.note,
        internal: t.internal,
      })),
    canEdit: editable && member(r, v),
    canSubmit: editable && responsibleMember(r, v),
    canWithdraw:
      OPEN.includes(p.status) &&
      (responsibleMember(r, v) || (p.status === "draft" && member(r, v) && p.createdBy === v.sub)),
    operator: v.operator,
  }
}

export function createPromotionService(
  store: PromotionStore,
  registry: { get(id: string): Promise<Record | null>; catalogue(): Promise<CatalogueEntry[]> },
  dashboardUrl: string,
  /** The association an event belongs to, so a request can promote only its own association's events. */
  eventAssociation: (eventId: string) => Promise<string | null> = async () => null
) {
  const eventOwner = async (content: PromotionContent) =>
    content.eventId ? await eventAssociation(content.eventId) : null
  const checkEvent = (content: PromotionContent, owner: string | null, r: Record) => {
    if (content.eventId && owner !== r.id) fail("BAD_REQUEST", "Choose an event of this association")
  }
  const mailFor = (p: Promotion, r: Record, v: Viewer, mail: Mail[], what: string, note: string) => {
    const url = `${dashboardUrl}/dashboard/associations/promotions/${p.id}`
    const label = promotionStatusLabel[p.status]
    for (const to of p.notify)
      mail.push({
        id: randomUUID(),
        to,
        subject: `Richiesta di promozione: ${label.toLowerCase()} — ${p.content.title || "senza titolo"}`,
        text: `${what}\n${note ? `\n${note}\n` : ""}\n${url}`,
        template: {
          kind: "association-promotion",
          props: {
            associationName: r.profile.name,
            title: p.content.title || "Richiesta senza titolo",
            status: label,
            summary: what,
            note: note || null,
            actor: v.name,
            url,
          },
        },
      })
  }
  async function readableRecord(v: Viewer, associationId: string) {
    const r = await registry.get(associationId)
    if (!r || !readable(r, v)) fail("NOT_FOUND", "Association not found")
    return r
  }
  return {
    async list(v: Viewer, associationId: string) {
      const r = await readableRecord(v, associationId)
      return (await store.promotions({ associationId })).map((p) => presentPromotion(p, r, v))
    },
    async get(v: Viewer, id: string) {
      const p = await store.promotion(id)
      if (!p) fail("NOT_FOUND", "Promotion request not found")
      const r = await registry.get(p.associationId)
      if (!r) fail("NOT_FOUND", "Promotion request not found")
      return presentPromotion(p, r, v)
    },
    /** Operators' queue across associations, by status and by desired or scheduled date. */
    async queue(v: Viewer, filter: z.infer<typeof promotionQueueSchema>) {
      if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
      const promotions = await store.promotions(filter)
      const records = new Map<string, Record | null>()
      for (const id of new Set(promotions.map((p) => p.associationId))) records.set(id, await registry.get(id))
      return promotions.flatMap((p) => {
        const r = records.get(p.associationId)
        return r ? [presentPromotion(p, r, v)] : []
      })
    },
    async create(v: Viewer, input: z.infer<typeof promotionCreateSchema>) {
      const catalogue = await registry.catalogue()
      const owner = await eventOwner(input.content)
      const id = await store.createPromotion(input.associationId, `${v.sub}:${input.commandId}`, (r) => {
        if (!member(r, v)) fail("FORBIDDEN", "Only the association's representatives can prepare a request")
        checkContent(input.content, catalogue, false)
        checkEvent(input.content, owner, r)
        const now = new Date().toISOString()
        const p: Promotion = {
          id: randomUUID(),
          associationId: r.id,
          status: "draft",
          revision: 0,
          content: input.content,
          createdBy: v.sub,
          createdByName: v.name,
          notify: v.email ? [v.email] : [],
          createdAt: now,
          updatedAt: now,
          scheduledAt: null,
          scheduledChannel: null,
          scheduledDetail: "",
          publishedUrl: null,
          publishedAt: null,
          transitions: [],
        }
        p.transitions.push({ ...transition(p, v, "draft"), from: null })
        return p
      })
      return { id }
    },
    async command(v: Viewer, c: PromotionCommand) {
      const catalogue = c.action === "save" || c.action === "submit" ? await registry.catalogue() : []
      const owner = c.action === "save" ? await eventOwner(c.content) : null
      const id = await store.changePromotion(c.id, `${v.sub}:${c.commandId}`, (p, r, mail, ledger) => {
        // Authorization is checked under the locks, before anything else: a revoked representative cannot act.
        if (!readable(r, v)) fail("NOT_FOUND", "Promotion request not found")
        if (p.revision !== c.revision) fail("CONFLICT", "The request changed. Reload before continuing.")
        const view = presentPromotion(p, r, v)
        const move = (to: PromotionStatus, note: string, what: string) => {
          p.transitions.push(transition(p, v, to, note))
          p.status = to
          mailFor(p, r, v, mail, what, note)
        }
        const operatorOnly = () => {
          if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
        }
        const from = (...allowed: PromotionStatus[]) => {
          if (!allowed.includes(p.status)) fail("CONFLICT", "The request cannot take this step in its current state")
        }
        switch (c.action) {
          case "save":
            if (!view.canEdit) fail("FORBIDDEN", "You cannot edit this request")
            checkContent(c.content, catalogue, false)
            checkEvent(c.content, owner, r)
            p.content = c.content
            break
          case "submit":
            if (!view.canSubmit) fail("FORBIDDEN", "Only the responsible can submit the request")
            checkContent(p.content, catalogue, true)
            if (v.email && !p.notify.includes(v.email)) p.notify.push(v.email)
            move("submitted", "", `${v.name} ha inviato la richiesta a PoliNetwork.`)
            break
          case "withdraw":
            if (!view.canWithdraw) fail("FORBIDDEN", "You cannot withdraw this request")
            settle(ledger, r, v, p, { action: "release" })
            move("withdrawn", c.note, `${v.name} ha ritirato la richiesta.`)
            break
          case "comment":
            if (!v.operator && !member(r, v)) fail("FORBIDDEN", "You cannot comment on this request")
            p.transitions.push(transition(p, v, null, c.note, v.operator && c.internal))
            if (v.operator && !c.internal) mailFor(p, r, v, mail, "PoliNetwork ha commentato la richiesta.", c.note)
            break
          case "changes":
            operatorOnly()
            from("submitted")
            move("changes_requested", c.note, "PoliNetwork chiede alcune modifiche prima di approvare la richiesta.")
            break
          case "approve":
            operatorOnly()
            from("submitted")
            if (r.status !== "active") fail("CONFLICT", "Reactivate the association before approving")
            settle(ledger, r, v, p, { action: "approve", cost: c.cost })
            move("approved", c.note, "PoliNetwork ha approvato la richiesta. Ti scriveremo quando sarà programmata.")
            break
          case "reject":
            operatorOnly()
            from("submitted", "approved", "scheduled")
            settle(ledger, r, v, p, { action: "release" })
            move("rejected", c.note, "PoliNetwork ha respinto la richiesta.")
            break
          case "schedule": {
            operatorOnly()
            from("approved", "scheduled")
            p.scheduledAt = new Date(c.scheduledAt).toISOString()
            p.scheduledChannel = c.channel
            p.scheduledDetail = c.detail
            const when = new Intl.DateTimeFormat("it-IT", {
              dateStyle: "full",
              timeStyle: "short",
              timeZone: "Europe/Rome",
            }).format(new Date(c.scheduledAt))
            move("scheduled", c.note, `La pubblicazione è programmata per ${when}.`)
            break
          }
          case "publish":
            operatorOnly()
            from("approved", "scheduled")
            p.publishedUrl = c.url
            p.publishedAt = new Date().toISOString()
            move("published", c.note, `La promozione è stata pubblicata: ${c.url}`)
            break
        }
        p.revision++
        p.updatedAt = new Date().toISOString()
      })
      return { id }
    },
  }
}
