import type { z } from "zod"
import type { homeActionKinds, homeSchema } from "./contract"
import type { EventStore } from "./events"
import type { Promotion, PromotionStore } from "./promotions"
import { activeMember, type Record, type Store, type Viewer } from "./service"

type Home = z.infer<typeof homeSchema>
type Action = Omit<Home["actions"][number], "kind"> & { kind: (typeof homeActionKinds)[number] }

const DAY = 86_400_000
const openContent = (r: Record) =>
  r.requests.find((q) => q.kind === "content" && ["draft", "changes", "submitted"].includes(q.status))

/**
 * What needs this viewer's attention, computed on the server from current state, most urgent first. Representatives
 * see their associations' items; operators also get queue counters. Nothing here is stored: an item disappears as soon
 * as its cause does.
 */
export function createHomeService(
  store: Pick<Store, "list">,
  promotions: Pick<PromotionStore, "promotions">,
  events: Pick<EventStore, "events"> = { events: async () => [] }
) {
  return {
    async home(v: Viewer): Promise<Home> {
      const records = await store.list()
      const mine = records.filter((r) => activeMember(r, v))
      const actions: Action[] = []
      const push = (r: Record, action: Omit<Action, "associationId" | "associationName">) =>
        actions.push({ associationId: r.id, associationName: r.profile.name, ...action })

      for (const r of records) {
        // The applicant's own registration and access requests.
        for (const q of r.requests) {
          if (q.by !== v.sub) continue
          if (q.status === "changes" && (q.kind === "registration" || q.kind === "access"))
            push(r, { kind: "request_changes", targetId: q.id, title: "", at: q.updatedAt, urgent: true })
        }
      }
      for (const r of mine) {
        const member = activeMember(r, v)
        const responsible = member?.role === "responsible" && r.status === "active"
        const working = openContent(r)
        if (working?.status === "changes")
          push(r, { kind: "profile_changes", targetId: working.id, title: "", at: working.updatedAt, urgent: true })
        else if (working?.status === "draft" && responsible) {
          const published = JSON.stringify(r.published?.contacts ?? [])
          const contactsOnly =
            working.profile &&
            JSON.stringify(working.profile.contacts) !== published &&
            JSON.stringify({ ...working.profile, contacts: [] }) === JSON.stringify({ ...r.profile, contacts: [] })
          push(r, {
            kind: contactsOnly ? "contacts_to_publish" : "profile_draft",
            targetId: working.id,
            title: "",
            at: working.updatedAt,
            urgent: false,
          })
        }
        const staleIds = new Set(
          [...(working?.profile ?? r.profile).contacts, ...r.contacts]
            .filter((c) => c.holderSub && !r.members.some((m) => m.sub === c.holderSub && m.active))
            .map((c) => c.label)
        )
        if (staleIds.size && member)
          push(r, { kind: "stale_contacts", targetId: null, title: [...staleIds].join(", "), at: null, urgent: true })
        if (r.handover && member?.role === "responsible")
          push(r, {
            kind: "handover_open",
            targetId: r.handover.id,
            title: r.handover.startedByName,
            at: r.handover.startedAt,
            urgent: r.handover.startedBy === v.sub,
          })
        if (responsible && r.registered && !r.published && !working)
          push(r, { kind: "profile_unpublished", targetId: null, title: "", at: null, urgent: false })

        for (const p of await promotions.promotions({ associationId: r.id })) {
          const title = p.content.title || "Richiesta senza titolo"
          const item = (kind: Action["kind"], at: string | null, urgent: boolean) =>
            push(r, { kind, targetId: p.id, title, at, urgent })
          if (p.status === "changes_requested") item("promotion_changes", p.updatedAt, true)
          else if (p.status === "draft" && (responsible || p.createdBy === v.sub))
            item(responsible ? "promotion_to_submit" : "promotion_draft", p.updatedAt, false)
          else if (p.status === "scheduled" && p.scheduledAt && Date.parse(p.scheduledAt) - Date.now() < 7 * DAY)
            item("promotion_scheduled", p.scheduledAt, false)
          else if (p.status === "published" && p.publishedAt && Date.now() - Date.parse(p.publishedAt) < 3 * DAY)
            item("promotion_published", p.publishedAt, false)
        }
        for (const e of await events.events({ associationId: r.id })) {
          const title = e.content.title || "Evento senza titolo"
          if (e.status === "changes_requested")
            push(r, { kind: "event_changes", targetId: e.id, title, at: e.updatedAt, urgent: true })
          else if (e.status === "draft" && (responsible || e.createdBy === v.sub))
            push(r, {
              kind: responsible ? "event_to_submit" : "event_draft",
              targetId: e.id,
              title,
              at: e.updatedAt,
              urgent: false,
            })
        }
      }

      let counters: Home["counters"] | null = null
      if (v.operator) {
        const submitted = records.flatMap((r) => r.requests.filter((q) => q.status === "submitted"))
        const queue: Promotion[] = await promotions.promotions({ status: "submitted" })
        counters = {
          profiles: submitted.filter((q) => q.kind === "content" || q.kind === "registration").length,
          access: submitted.filter((q) => q.kind === "access" || q.kind === "membership").length,
          promotions: queue.length,
          events: (await events.events({ status: "submitted" })).length,
          handovers: records.filter((r) => r.handover).length,
        }
      }
      actions.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.at ?? "9999").localeCompare(b.at ?? "9999"))
      return { operator: v.operator, actions, counters }
    },
  }
}
