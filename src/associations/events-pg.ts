import { TRPCError } from "@trpc/server"
import { and, asc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm"
import type { DB } from "@/db"
import { associationEvent, associationEventTransition } from "@/db/schema/web/association-portal"
import type { CalendarEvent, EventStore } from "./events"
import { claimKey, lockAssociation, queueMail, usedKey } from "./promotions-pg"
import type { Mail } from "./service"

type Row = typeof associationEvent.$inferSelect
type TransitionRow = typeof associationEventTransition.$inferSelect

function toEvent(row: Row, transitions: TransitionRow[]): CalendarEvent {
  return {
    id: row.id,
    associationId: row.associationId,
    status: row.status,
    revision: row.revision,
    content: row.content,
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    notify: row.notify,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    transitions: transitions.map((t) => ({
      id: t.id,
      kind: t.kind,
      from: t.fromStatus ?? null,
      to: t.toStatus ?? null,
      at: t.at.toISOString(),
      actorSub: t.actorSub,
      actorName: t.actorName,
      note: t.note,
      internal: t.internal,
    })),
  }
}
const toRow = (e: CalendarEvent) => ({
  id: e.id,
  associationId: e.associationId,
  status: e.status,
  revision: e.revision,
  content: e.content,
  createdBy: e.createdBy,
  createdByName: e.createdByName,
  notify: e.notify,
  startsAt: e.content.startsAt ? new Date(e.content.startsAt) : null,
  endsAt: e.content.endsAt ? new Date(e.content.endsAt) : null,
  createdAt: new Date(e.createdAt),
  updatedAt: new Date(e.updatedAt),
})
const transitionRows = (e: CalendarEvent, known: Set<string>) =>
  e.transitions
    .filter((t) => !known.has(t.id))
    .map((t) => ({
      id: t.id,
      eventId: e.id,
      kind: t.kind,
      fromStatus: t.from,
      toStatus: t.to,
      actorSub: t.actorSub,
      actorName: t.actorName,
      note: t.note,
      internal: t.internal,
      at: new Date(t.at),
    }))

export function createEventStore(db: typeof DB): EventStore {
  async function withTransitions(rows: Row[]) {
    if (!rows.length) return []
    const transitions = await db
      .select()
      .from(associationEventTransition)
      .where(
        inArray(
          associationEventTransition.eventId,
          rows.map((r) => r.id)
        )
      )
      .orderBy(asc(associationEventTransition.at))
    return rows.map((row) =>
      toEvent(
        row,
        transitions.filter((t) => t.eventId === row.id)
      )
    )
  }
  return {
    async events(filter) {
      const day = sql`(${associationEvent.startsAt} AT TIME ZONE 'Europe/Rome')::date`
      const where: SQL[] = []
      if (filter.associationId) where.push(eq(associationEvent.associationId, filter.associationId))
      if (filter.status) where.push(eq(associationEvent.status, filter.status))
      if (filter.from) where.push(gte(day, filter.from))
      if (filter.to) where.push(lte(day, filter.to))
      // Upcoming: not over yet (an event without an end counts as over once it starts plus a day).
      if (filter.upcoming)
        where.push(sql`coalesce(${associationEvent.endsAt}, ${associationEvent.startsAt} + interval '1 day') >= now()`)
      const rows = await db
        .select()
        .from(associationEvent)
        .where(and(...where))
        .orderBy(sql`${associationEvent.startsAt} ASC NULLS LAST`, asc(associationEvent.createdAt))
      return withTransitions(rows)
    },
    async event(id) {
      const rows = await db.select().from(associationEvent).where(eq(associationEvent.id, id))
      return (await withTransitions(rows))[0] ?? null
    },
    async createEvent(associationId, key, operation) {
      const replay = await usedKey(db, key)
      if (replay) return replay
      return db.transaction(async (tx) => {
        const record = await lockAssociation(tx, associationId)
        const replayed = await usedKey(tx, key)
        if (replayed) return replayed
        const mail: Mail[] = []
        const e = operation(record, mail)
        if (!(await claimKey(tx, key, e.id))) return (await usedKey(tx, key)) as string
        await tx.insert(associationEvent).values(toRow(e))
        const transitions = transitionRows(e, new Set())
        if (transitions.length) await tx.insert(associationEventTransition).values(transitions)
        await queueMail(tx, mail)
        return e.id
      })
    },
    async changeEvent(id, key, operation) {
      const replay = await usedKey(db, key)
      if (replay) return replay
      const [head] = await db
        .select({ associationId: associationEvent.associationId })
        .from(associationEvent)
        .where(eq(associationEvent.id, id))
      if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" })
      return db.transaction(async (tx) => {
        const record = await lockAssociation(tx, head.associationId)
        const [row] = await tx.select().from(associationEvent).where(eq(associationEvent.id, id)).for("update")
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Event not found" })
        if (await usedKey(tx, key)) return id
        const stored = await tx
          .select()
          .from(associationEventTransition)
          .where(eq(associationEventTransition.eventId, id))
          .orderBy(asc(associationEventTransition.at))
        const e = toEvent(row, stored)
        const mail: Mail[] = []
        operation(e, record, mail)
        if (!(await claimKey(tx, key, id))) return id
        await tx.update(associationEvent).set(toRow(e)).where(eq(associationEvent.id, id))
        const transitions = transitionRows(e, new Set(stored.map((t) => t.id)))
        if (transitions.length) await tx.insert(associationEventTransition).values(transitions)
        await queueMail(tx, mail)
        return id
      })
    },
  }
}
