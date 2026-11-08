import { Cron } from "croner"
import { lt } from "drizzle-orm"
import { AUDIT_EVENTS_RETENTION_MONTHS, MESSAGES_RETENTION_DAYS } from "./constants"
import { DB, SCHEMA } from "./db"
import { env } from "./env"
import { logger } from "./logger"
import { endedMeasures } from "./utils/audit-log"

export function cron() {
  new Cron("0 23 4 * * *", async () => {
    logger.info("[CRON] start")
    await cleanMessages()
    await cleanAuditLog()
    await cleanAuditEvents()
    logger.info("[CRON] end")
  })

  // Expired signing jobs drop their prepared PDFs; abandoned uploads go after a day.
  new Cron("0 */10 * * * *", async () => {
    try {
      const { esign } = await import("./esign")
      await esign.sweep()
    } catch (err) {
      logger.error(err, "[CRON] esign sweep")
    }
  })

  logger.info("[CRON] scheduled")
  new Cron("0 * * * * *", async () => {
    try {
      const { people } = await import("./people")
      await people.deliverPending()
    } catch (err) {
      logger.error(err, "[CRON] People mail outbox")
    }
  })
}

async function cleanMessages() {
  // do not run this cronjob unless in production
  if (env.NODE_ENV !== "production") return

  logger.info(`[CRON] START(cleanMessages) retention days = ${MESSAGES_RETENTION_DAYS}`)

  const daysAgo = new Date()
  daysAgo.setDate(daysAgo.getDate() - MESSAGES_RETENTION_DAYS)
  try {
    const deleted = await DB.delete(SCHEMA.TG.messages).where(lt(SCHEMA.TG.messages.timestamp, daysAgo)).returning()
    logger.info(`[CRON] END(cleanMessages) deleted ${deleted.length} message(s).`)
  } catch (err) {
    logger.error(err, "[CRON] cleanMessages")
  }
}

export async function cleanAuditLog() {
  logger.info(`[CRON] START(cleanAuditLog)`)

  try {
    const deleted = await DB.delete(SCHEMA.TG.auditLog)
      .where(endedMeasures(new Date()))
      .returning({ id: SCHEMA.TG.auditLog.id })
    logger.info(`[CRON] END(cleanAuditLog) deleted ${deleted.length} audit log record(s).`)
  } catch (err) {
    logger.error(err, "[CRON] cleanAuditLog")
  }
}

/** Deletes the backend audit events past their retention. */
export async function cleanAuditEvents(now = new Date()) {
  logger.info(`[CRON] START(cleanAuditEvents) retention months = ${AUDIT_EVENTS_RETENTION_MONTHS}`)

  const cutoff = new Date(now)
  cutoff.setMonth(cutoff.getMonth() - AUDIT_EVENTS_RETENTION_MONTHS)
  try {
    const deleted = await DB.delete(SCHEMA.COMMON.auditEvents)
      .where(lt(SCHEMA.COMMON.auditEvents.createdAt, cutoff))
      .returning({ id: SCHEMA.COMMON.auditEvents.id })
    logger.info(`[CRON] END(cleanAuditEvents) deleted ${deleted.length} audit event(s).`)
  } catch (err) {
    logger.error(err, "[CRON] cleanAuditEvents")
  }
}
