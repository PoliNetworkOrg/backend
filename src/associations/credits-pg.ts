import { randomUUID } from "node:crypto"
import { asc, eq, sql } from "drizzle-orm"
import type { DB } from "@/db"
import { associationCreditConfig, associationCreditEntry } from "@/db/schema/web/association-portal"
import { type CreditConfig, RRI_CREDIT_RULES } from "./contract"
import type { CreditStore, Ledger, NewCreditEntry, StoredCreditEntry } from "./credits"
import { claimKey, lockAssociation, type Tx, usedKey } from "./promotions-pg"

type Row = typeof associationCreditEntry.$inferSelect
const toEntry = (row: Row): StoredCreditEntry => ({
  id: row.id,
  associationId: row.associationId,
  kind: row.kind,
  amount: row.amount,
  reason: row.reason,
  authorSub: row.authorSub,
  authorName: row.authorName,
  promotionId: row.promotionId,
  reversesId: row.reversesId,
  period: row.period,
  createdAt: row.createdAt.toISOString(),
})

async function readConfig(tx: Tx | typeof DB): Promise<CreditConfig> {
  const [row] = await tx.select().from(associationCreditConfig).where(eq(associationCreditConfig.id, 1))
  return row?.config ?? RRI_CREDIT_RULES
}

/**
 * The association's ledger for this transaction. An advisory lock per association serializes everything that reads the
 * balance and then writes to it, so two approvals cannot both spend the same credits. `flush` writes what was posted.
 */
export async function openLedger(tx: Tx, associationId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`credits:${associationId}`}, 0))`)
  const config = await readConfig(tx)
  const rows = await tx
    .select()
    .from(associationCreditEntry)
    .where(eq(associationCreditEntry.associationId, associationId))
    .orderBy(asc(associationCreditEntry.createdAt))
  const posted: NewCreditEntry[] = []
  const ledger: Ledger = {
    config,
    entries: rows.map(toEntry),
    post: (entry) => {
      posted.push(entry)
    },
  }
  return {
    ledger,
    async flush() {
      if (!posted.length) return
      const now = Date.now()
      await tx.insert(associationCreditEntry).values(
        posted.map((e, i) => ({
          ...e,
          id: randomUUID(),
          associationId,
          // Entries posted together keep their order.
          createdAt: new Date(now + i),
        }))
      )
    },
  }
}

export function createCreditStore(db: typeof DB): CreditStore {
  return {
    config: () => readConfig(db),
    async saveConfig(config, actor) {
      const values = { id: 1, config, updatedBySub: actor, updatedAt: new Date() }
      await db.insert(associationCreditConfig).values(values).onConflictDoUpdate({
        target: associationCreditConfig.id,
        set: values,
      })
    },
    async entries(associationId) {
      return (
        await db
          .select()
          .from(associationCreditEntry)
          .where(eq(associationCreditEntry.associationId, associationId))
          .orderBy(asc(associationCreditEntry.createdAt))
      ).map(toEntry)
    },
    async post(associationId, key, operation) {
      const replay = await usedKey(db, key)
      if (replay) return replay
      return db.transaction(async (tx) => {
        const record = await lockAssociation(tx, associationId)
        const { ledger, flush } = await openLedger(tx, associationId)
        if (await usedKey(tx, key)) return associationId
        operation(ledger, record)
        if (!(await claimKey(tx, key, associationId))) return associationId
        await flush()
        return associationId
      })
    },
    async semester(input, author, associationIds) {
      let granted = 0
      for (const associationId of associationIds) {
        // One transaction per association, so a busy one does not hold the others.
        const done = await db.transaction(async (tx) => {
          await lockAssociation(tx, associationId)
          const { ledger, flush } = await openLedger(tx, associationId)
          if (ledger.entries.some((e) => e.kind === "credit" && e.period === input.period)) return false
          const balance = ledger.entries.reduce((sum, e) => sum + e.amount, 0)
          if (input.resetUnused && balance > 0)
            ledger.post({
              kind: "adjustment",
              amount: -balance,
              reason: `Crediti non usati scaduti (${input.period})`,
              authorSub: author.sub,
              authorName: author.name,
              promotionId: null,
              reversesId: null,
              period: null,
            })
          ledger.post({
            kind: "credit",
            amount: input.amount,
            reason: input.reason,
            authorSub: author.sub,
            authorName: author.name,
            promotionId: null,
            reversesId: null,
            period: input.period,
          })
          await flush()
          return true
        })
        if (done) granted++
      }
      return granted
    },
  }
}
