import { and, eq, isNull, lte, sql } from "drizzle-orm"
import { DB } from "@/db"
import { associationMail } from "@/db/schema/web/association-portal"
import { sendAssociationEmail } from "@/emails/mailer"
import { env } from "@/env"
import { idp } from "@/idp"
import { logger } from "@/logger"
import { createAssociationService } from "./service"
import { createAssociationStore } from "./store-pg"

export const associationStore = createAssociationStore(DB)
export const associationPortal = createAssociationService(associationStore, env.ESIGN_DASHBOARD_URL.replace(/\/$/, ""))

/** Durable retries, SKIP LOCKED across replicas. Delivery is at-least-once, with a stable Message-ID. */
export async function deliverAssociationMail() {
  for (let n = 0; n < 20; n++) {
    const done = await DB.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(associationMail)
        .where(and(isNull(associationMail.sentAt), lte(associationMail.nextAttempt, new Date())))
        .limit(1)
        .for("update", { skipLocked: true })
      if (!row) return true
      try {
        await sendAssociationEmail(row.mail)
        // Erase the invitation URL from the outbox after delivery; only the hash remains in the registry.
        await tx
          .update(associationMail)
          .set({ sentAt: new Date(), mail: { ...row.mail, text: "Delivered" } })
          .where(eq(associationMail.id, row.id))
      } catch (error) {
        logger.error({ error, mailId: row.id }, "Association notification delivery failed")
        await tx
          .update(associationMail)
          .set({
            attempts: sql`${associationMail.attempts} + 1`,
            nextAttempt: new Date(Date.now() + Math.min(3600, 60 * 2 ** Math.min(row.attempts, 6)) * 1000),
          })
          .where(eq(associationMail.id, row.id))
      }
      return false
    })
    if (done) break
  }
}

export async function associationIdentity(sub: string) {
  const account = (await idp?.directory?.())?.find((account) => account.sub === sub)
  return { name: account?.name ?? sub, email: account?.email ?? undefined }
}
