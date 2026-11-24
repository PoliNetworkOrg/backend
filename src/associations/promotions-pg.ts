import { TRPCError } from "@trpc/server"
import { and, asc, eq, gte, inArray, lte, type SQL, sql } from "drizzle-orm"
import type { DB } from "@/db"
import {
  associationCommandKey,
  associationMail,
  associationPromotion,
  associationPromotionTransition,
  associationRegistry,
} from "@/db/schema/web/association-portal"
import { openLedger } from "./credits-pg"
import type { Promotion, PromotionStore } from "./promotions"
import { type Mail, normalizeRecord } from "./service"

export type Tx = Parameters<Parameters<typeof DB.transaction>[0]>[0]
type Row = typeof associationPromotion.$inferSelect
type TransitionRow = typeof associationPromotionTransition.$inferSelect

const iso = (d: Date | null) => (d ? d.toISOString() : null)
function toPromotion(row: Row, transitions: TransitionRow[]): Promotion {
  return {
    id: row.id,
    associationId: row.associationId,
    status: row.status,
    revision: row.revision,
    // Rows written before events existed have no `eventId`.
    content: { ...row.content, eventId: row.content.eventId ?? null },
    createdBy: row.createdBy,
    createdByName: row.createdByName,
    notify: row.notify,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    scheduledAt: iso(row.scheduledAt),
    scheduledChannel: row.scheduledChannel as Promotion["scheduledChannel"],
    scheduledDetail: row.scheduledDetail,
    publishedUrl: row.publishedUrl,
    publishedAt: iso(row.publishedAt),
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
function toRow(p: Promotion) {
  return {
    id: p.id,
    associationId: p.associationId,
    status: p.status,
    revision: p.revision,
    content: p.content,
    createdBy: p.createdBy,
    createdByName: p.createdByName,
    notify: p.notify,
    desiredDate: p.content.desiredDate,
    scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : null,
    scheduledChannel: p.scheduledChannel,
    scheduledDetail: p.scheduledDetail,
    publishedUrl: p.publishedUrl,
    publishedAt: p.publishedAt ? new Date(p.publishedAt) : null,
    createdAt: new Date(p.createdAt),
    updatedAt: new Date(p.updatedAt),
  }
}
const transitionRows = (p: Promotion, known: Set<string>) =>
  p.transitions
    .filter((t) => !known.has(t.id))
    .map((t) => ({
      id: t.id,
      promotionId: p.id,
      kind: t.kind,
      fromStatus: t.from,
      toStatus: t.to,
      actorSub: t.actorSub,
      actorName: t.actorName,
      note: t.note,
      internal: t.internal,
      at: new Date(t.at),
    }))

/** Shared lock on the association: membership cannot change underneath, other requests can proceed. */
export async function lockAssociation(tx: Tx, id: string) {
  const [row] = await tx.select().from(associationRegistry).where(eq(associationRegistry.id, id)).for("share")
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Association not found" })
  return normalizeRecord(row.state)
}
/** Records the key; `false` when it was already used (possibly by a concurrent retry, which this waits for). */
export async function claimKey(tx: Tx, key: string, result: string) {
  const inserted = await tx
    .insert(associationCommandKey)
    .values({ key, result })
    .onConflictDoNothing()
    .returning({ key: associationCommandKey.key })
  return inserted.length > 0
}
export async function usedKey(tx: Tx | typeof DB, key: string) {
  const [row] = await tx.select().from(associationCommandKey).where(eq(associationCommandKey.key, key))
  return row?.result
}
export async function queueMail(tx: Tx, mail: Mail[]) {
  if (mail.length) await tx.insert(associationMail).values(mail.map((m) => ({ id: m.id, mail: m })))
}

export function createPromotionStore(db: typeof DB): PromotionStore {
  return {
    async promotions(filter) {
      // The queue's date is the scheduled day once there is one, else the desired day.
      const day = sql`coalesce((${associationPromotion.scheduledAt} AT TIME ZONE 'Europe/Rome')::date, ${associationPromotion.desiredDate})`
      const where: SQL[] = []
      if (filter.associationId) where.push(eq(associationPromotion.associationId, filter.associationId))
      if (filter.status) where.push(eq(associationPromotion.status, filter.status))
      if (filter.from) where.push(gte(day, filter.from))
      if (filter.to) where.push(lte(day, filter.to))
      const rows = await db
        .select()
        .from(associationPromotion)
        .where(and(...where))
        .orderBy(sql`${day} ASC NULLS LAST`, asc(associationPromotion.createdAt))
      if (!rows.length) return []
      const transitions = await db
        .select()
        .from(associationPromotionTransition)
        .where(
          inArray(
            associationPromotionTransition.promotionId,
            rows.map((r) => r.id)
          )
        )
        .orderBy(asc(associationPromotionTransition.at))
      return rows.map((row) =>
        toPromotion(
          row,
          transitions.filter((t) => t.promotionId === row.id)
        )
      )
    },
    async promotion(id) {
      const [row] = await db.select().from(associationPromotion).where(eq(associationPromotion.id, id))
      if (!row) return null
      const transitions = await db
        .select()
        .from(associationPromotionTransition)
        .where(eq(associationPromotionTransition.promotionId, id))
        .orderBy(asc(associationPromotionTransition.at))
      return toPromotion(row, transitions)
    },
    async createPromotion(associationId, key, operation) {
      const replay = await usedKey(db, key)
      if (replay) return replay
      return db.transaction(async (tx) => {
        const record = await lockAssociation(tx, associationId)
        const replayed = await usedKey(tx, key)
        if (replayed) return replayed
        const mail: Mail[] = []
        const p = operation(record, mail)
        if (!(await claimKey(tx, key, p.id))) return (await usedKey(tx, key)) as string
        await tx.insert(associationPromotion).values(toRow(p))
        const transitions = transitionRows(p, new Set())
        if (transitions.length) await tx.insert(associationPromotionTransition).values(transitions)
        await queueMail(tx, mail)
        return p.id
      })
    },
    async changePromotion(id, key, operation) {
      const replay = await usedKey(db, key)
      if (replay) return replay
      const [head] = await db
        .select({ associationId: associationPromotion.associationId })
        .from(associationPromotion)
        .where(eq(associationPromotion.id, id))
      if (!head) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion request not found" })
      return db.transaction(async (tx) => {
        // Always association first, then the request: the same order as every other writer.
        const record = await lockAssociation(tx, head.associationId)
        const [row] = await tx.select().from(associationPromotion).where(eq(associationPromotion.id, id)).for("update")
        if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Promotion request not found" })
        // A concurrent retry of this command held the lock first: return its result, do not apply it twice.
        if (await usedKey(tx, key)) return id
        const stored = await tx
          .select()
          .from(associationPromotionTransition)
          .where(eq(associationPromotionTransition.promotionId, id))
          .orderBy(asc(associationPromotionTransition.at))
        const p = toPromotion(row, stored)
        const mail: Mail[] = []
        const { ledger, flush } = await openLedger(tx, head.associationId)
        operation(p, record, mail, ledger)
        if (!(await claimKey(tx, key, id))) return id
        await flush()
        await tx.update(associationPromotion).set(toRow(p)).where(eq(associationPromotion.id, id))
        const transitions = transitionRows(p, new Set(stored.map((t) => t.id)))
        if (transitions.length) await tx.insert(associationPromotionTransition).values(transitions)
        await queueMail(tx, mail)
        return id
      })
    },
  }
}
