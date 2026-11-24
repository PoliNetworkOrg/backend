import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm"
import { DB } from "@/db"
import { associationCommandKey, associationMail } from "@/db/schema/web/association-portal"
import { sendAssociationEmail } from "@/emails/mailer"
import { env } from "@/env"
import { idp } from "@/idp"
import { logger } from "@/logger"
import { createEventService } from "./events"
import { createEventStore } from "./events-pg"
import { createHomeService } from "./home"
import { createPromotionService } from "./promotions"
import { createPromotionStore } from "./promotions-pg"
import { createAssociationService } from "./service"
import { createAssociationStore } from "./store-pg"

const dashboardUrl = env.ESIGN_DASHBOARD_URL.replace(/\/$/, "")
export const associationStore = createAssociationStore(DB)
export const associationPortal = createAssociationService(associationStore, dashboardUrl)
const promotionStore = createPromotionStore(DB)
export const associationEventStore = createEventStore(DB)
export const associationEvents = createEventService(associationEventStore, associationStore, dashboardUrl)
export const associationPromotions = createPromotionService(
  promotionStore,
  associationStore,
  dashboardUrl,
  async (id) => (await associationEventStore.event(id))?.associationId ?? null
)
export const associationHome = createHomeService(associationStore, promotionStore, associationEventStore)

const LEASE_MS = 5 * 60_000
const MAX_ATTEMPTS = 20
const RETENTION_MS = 30 * 86_400_000

/**
 * Durable retries across replicas. A row is leased in a short transaction (nextAttempt pushed forward), then sent
 * outside any transaction, so no connection or row lock is held during delivery. Delivery is at-least-once, with a
 * stable Message-ID. Rows that keep failing are scrubbed and closed; delivered rows are purged after a retention period.
 */
export async function deliverAssociationMail() {
  await DB.delete(associationMail).where(
    and(isNotNull(associationMail.sentAt), lte(associationMail.sentAt, new Date(Date.now() - RETENTION_MS)))
  )
  // Retries only matter for a short window, like the registry's bounded command keys.
  await DB.delete(associationCommandKey).where(
    lte(associationCommandKey.createdAt, new Date(Date.now() - RETENTION_MS))
  )
  for (let n = 0; n < 20; n++) {
    const row = await DB.transaction(async (tx) => {
      const [claimed] = await tx
        .select()
        .from(associationMail)
        .where(and(isNull(associationMail.sentAt), lte(associationMail.nextAttempt, new Date())))
        .limit(1)
        .for("update", { skipLocked: true })
      if (claimed)
        await tx
          .update(associationMail)
          .set({ nextAttempt: new Date(Date.now() + LEASE_MS) })
          .where(eq(associationMail.id, claimed.id))
      return claimed
    })
    if (!row) break
    try {
      await sendAssociationEmail(row.mail)
      // Erase the invitation URL from the outbox after delivery; only the hash remains in the registry.
      await DB.update(associationMail)
        .set({
          sentAt: new Date(),
          mail: { id: row.mail.id, to: row.mail.to, subject: row.mail.subject, text: "Delivered" },
        })
        .where(eq(associationMail.id, row.id))
    } catch (error) {
      logger.error({ error, mailId: row.id }, "Association notification delivery failed")
      if (row.attempts + 1 >= MAX_ATTEMPTS)
        await DB.update(associationMail)
          .set({
            sentAt: new Date(),
            attempts: row.attempts + 1,
            mail: { id: row.mail.id, to: row.mail.to, subject: row.mail.subject, text: "Undeliverable" },
          })
          .where(eq(associationMail.id, row.id))
      else
        await DB.update(associationMail)
          .set({
            attempts: sql`${associationMail.attempts} + 1`,
            nextAttempt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)) * 1000),
          })
          .where(eq(associationMail.id, row.id))
    }
  }
}

const IDENTITY_TTL_MS = 60_000
let directoryCache: { at: number; accounts: { sub: string; name?: string | null; email?: string | null }[] } | null =
  null

export async function associationIdentity(sub: string) {
  if (!idp?.directory) return { name: sub, email: undefined }
  if (!directoryCache || Date.now() - directoryCache.at > IDENTITY_TTL_MS) {
    try {
      directoryCache = { at: Date.now(), accounts: await idp.directory() }
    } catch (error) {
      // A directory outage must not lock every representative out; fall back to stale data or the bare subject.
      logger.warn({ error }, "Association identity directory unavailable")
      // Retry in 10 seconds, not on every call: each failed lookup can wait for the IdP timeout.
      directoryCache = { accounts: directoryCache?.accounts ?? [], at: Date.now() - IDENTITY_TTL_MS + 10_000 }
    }
  }
  const account = directoryCache?.accounts.find((account) => account.sub === sub)
  return { name: account?.name ?? sub, email: account?.email ?? undefined }
}
