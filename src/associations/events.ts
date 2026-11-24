import { randomUUID } from "node:crypto"
import type { z } from "zod"
import type {
  CalendarEventCommand,
  CalendarEventContent,
  CatalogueEntry,
  calendarEventCreateSchema,
  calendarEventQueueSchema,
  EventStatus,
  PromotionTransition,
} from "./contract"
import { activeMember, fail, type Mail, type Record, type Viewer } from "./service"

/** An event for the shared calendar, with its append-only transitions. */
export type CalendarEvent = {
  id: string
  associationId: string
  status: EventStatus
  revision: number
  content: CalendarEventContent
  createdBy: string
  createdByName: string
  notify: string[]
  createdAt: string
  updatedAt: string
  transitions: (Omit<PromotionTransition, "from" | "to"> & {
    from: EventStatus | null
    to: EventStatus | null
    actorSub: string
  })[]
}
export type EventFilter = z.infer<typeof calendarEventQueueSchema> & { associationId?: string; upcoming?: boolean }
export type EventStore = {
  events(filter: EventFilter): Promise<CalendarEvent[]>
  event(id: string): Promise<CalendarEvent | null>
  /** Same locking and command-key rules as `PromotionStore.createPromotion`. */
  createEvent(
    associationId: string,
    key: string,
    operation: (record: Record, mail: Mail[]) => CalendarEvent
  ): Promise<string>
  changeEvent(
    id: string,
    key: string,
    operation: (event: CalendarEvent, record: Record, mail: Mail[]) => void
  ): Promise<string>
}

export const eventStatusLabel = {
  draft: "Bozza",
  submitted: "In revisione",
  changes_requested: "Modifiche richieste",
  approved: "Approvato",
  rejected: "Respinto",
  withdrawn: "Ritirato",
} satisfies { [S in EventStatus]: string }

const member = (r: Record, v: Viewer) => r.status === "active" && !!activeMember(r, v)
const responsibleMember = (r: Record, v: Viewer) => r.status === "active" && activeMember(r, v)?.role === "responsible"
const readable = (r: Record, v: Viewer) => v.operator || !!activeMember(r, v)

function checkContent(c: CalendarEventContent, catalogue: CatalogueEntry[], complete: boolean) {
  if (c.campus && !catalogue.some((e) => e.kind === "campus" && e.slug === c.campus && e.active))
    fail("BAD_REQUEST", "Choose campuses from the catalogue")
  if (c.startsAt && c.endsAt && Date.parse(c.endsAt) < Date.parse(c.startsAt))
    fail("BAD_REQUEST", "The event cannot end before it starts")
  if (!complete) return
  if (!c.title || !c.descriptionIt || !c.descriptionEn)
    fail("BAD_REQUEST", "Add a title and both descriptions before submitting")
  if (!c.startsAt) fail("BAD_REQUEST", "Choose when the event starts")
  if (Date.parse(c.startsAt) < Date.now()) fail("BAD_REQUEST", "The event has already started")
  if (!c.online && !c.venue) fail("BAD_REQUEST", "Add the venue, or mark the event as online")
}

export function presentEvent(e: CalendarEvent, r: Record, v: Viewer) {
  if (!readable(r, v)) fail("NOT_FOUND", "Event not found")
  const editable = e.status === "draft" || e.status === "changes_requested"
  return {
    id: e.id,
    associationId: e.associationId,
    associationName: r.profile.name,
    status: e.status,
    revision: e.revision,
    content: e.content,
    createdByName: e.createdByName,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    transitions: e.transitions
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
    // An approved event can be taken off the calendar by its responsible.
    canWithdraw:
      ["draft", "submitted", "changes_requested", "approved"].includes(e.status) &&
      (responsibleMember(r, v) || (e.status === "draft" && member(r, v) && e.createdBy === v.sub)),
    operator: v.operator,
  }
}

export function createEventService(
  store: EventStore,
  registry: { get(id: string): Promise<Record | null>; catalogue(): Promise<CatalogueEntry[]> },
  dashboardUrl: string
) {
  const mailFor = (e: CalendarEvent, r: Record, v: Viewer, mail: Mail[], summary: string, note: string) => {
    const url = `${dashboardUrl}/dashboard/associations/events/${e.id}`
    const status = eventStatusLabel[e.status]
    for (const to of e.notify)
      mail.push({
        id: randomUUID(),
        to,
        subject: `Evento: ${status.toLowerCase()} — ${e.content.title || "senza titolo"}`,
        text: `${summary}\n${note ? `\n${note}\n` : ""}\n${url}`,
        template: {
          kind: "association-event",
          props: {
            associationName: r.profile.name,
            title: e.content.title || "Evento senza titolo",
            status,
            summary,
            note: note || null,
            actor: v.name,
            url,
          },
        },
      })
  }
  return {
    async list(v: Viewer, associationId: string) {
      const r = await registry.get(associationId)
      if (!r || !readable(r, v)) fail("NOT_FOUND", "Association not found")
      return (await store.events({ associationId })).map((e) => presentEvent(e, r, v))
    },
    async get(v: Viewer, id: string) {
      const e = await store.event(id)
      const r = e && (await registry.get(e.associationId))
      if (!e || !r) fail("NOT_FOUND", "Event not found")
      return presentEvent(e, r, v)
    },
    async queue(v: Viewer, filter: z.infer<typeof calendarEventQueueSchema>) {
      if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
      const events = await store.events(filter)
      const records = new Map<string, Record | null>()
      for (const id of new Set(events.map((e) => e.associationId))) records.set(id, await registry.get(id))
      return events.flatMap((e) => {
        const r = records.get(e.associationId)
        return r ? [presentEvent(e, r, v)] : []
      })
    },
    async create(v: Viewer, input: z.infer<typeof calendarEventCreateSchema>) {
      const catalogue = await registry.catalogue()
      const id = await store.createEvent(input.associationId, `${v.sub}:${input.commandId}`, (r) => {
        if (!member(r, v)) fail("FORBIDDEN", "Only the association's representatives can propose an event")
        checkContent(input.content, catalogue, false)
        const now = new Date().toISOString()
        return {
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
          transitions: [
            {
              id: randomUUID(),
              kind: "transition",
              from: null,
              to: "draft",
              at: now,
              actorSub: v.sub,
              actorName: v.name,
              note: "",
              internal: false,
            },
          ],
        }
      })
      return { id }
    },
    async command(v: Viewer, c: CalendarEventCommand) {
      const catalogue = c.action === "save" || c.action === "submit" ? await registry.catalogue() : []
      const id = await store.changeEvent(c.id, `${v.sub}:${c.commandId}`, (e, r, mail) => {
        if (!readable(r, v)) fail("NOT_FOUND", "Event not found")
        if (e.revision !== c.revision) fail("CONFLICT", "The event changed. Reload before continuing.")
        const view = presentEvent(e, r, v)
        const record = (to: EventStatus | null, note: string, internal = false) =>
          e.transitions.push({
            id: randomUUID(),
            kind: to ? "transition" : "comment",
            from: to ? e.status : null,
            to,
            at: new Date().toISOString(),
            actorSub: v.sub,
            actorName: v.name,
            note,
            internal,
          })
        const move = (to: EventStatus, note: string, summary: string) => {
          record(to, note)
          e.status = to
          mailFor(e, r, v, mail, summary, note)
        }
        const decide = () => {
          if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
          if (e.status !== "submitted") fail("CONFLICT", "The request cannot take this step in its current state")
        }
        switch (c.action) {
          case "save":
            if (!view.canEdit) fail("FORBIDDEN", "You cannot edit this event")
            checkContent(c.content, catalogue, false)
            e.content = c.content
            break
          case "submit":
            if (!view.canSubmit) fail("FORBIDDEN", "Only the responsible can submit the event")
            checkContent(e.content, catalogue, true)
            if (v.email && !e.notify.includes(v.email)) e.notify.push(v.email)
            move("submitted", "", `${v.name} ha inviato l’evento a PoliNetwork.`)
            break
          case "withdraw":
            if (!view.canWithdraw) fail("FORBIDDEN", "You cannot withdraw this event")
            move(
              "withdrawn",
              c.note,
              e.status === "approved"
                ? `${v.name} ha tolto l’evento dal calendario.`
                : `${v.name} ha ritirato l’evento.`
            )
            break
          case "comment":
            if (!v.operator && !member(r, v)) fail("FORBIDDEN", "You cannot comment on this request")
            record(null, c.note, v.operator && c.internal)
            if (v.operator && !c.internal) mailFor(e, r, v, mail, "PoliNetwork ha commentato l’evento.", c.note)
            break
          case "changes":
            decide()
            move("changes_requested", c.note, "PoliNetwork chiede alcune modifiche prima di pubblicare l’evento.")
            break
          case "approve":
            decide()
            if (r.status !== "active") fail("CONFLICT", "Reactivate the association before approving")
            move("approved", c.note, "PoliNetwork ha approvato l’evento: ora è nel calendario del sito.")
            break
          case "reject":
            if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
            if (e.status !== "submitted" && e.status !== "approved")
              fail("CONFLICT", "The request cannot take this step in its current state")
            move("rejected", c.note, "PoliNetwork ha respinto l’evento.")
            break
        }
        e.revision++
        e.updatedAt = new Date().toISOString()
      })
      return { id }
    },
  }
}
