import { Cron } from "croner"
import { lt } from "drizzle-orm"
import { MESSAGES_RETENTION_DAYS, SESSIONS_RETENTION_DAYS } from "./constants"
import { DB, SCHEMA } from "./db"
import { env } from "./env"
import { logger } from "./logger"
import { endedMeasures } from "./utils/audit-log"

export function cron() {
  new Cron("0 23 4 * * *", async () => {
    logger.info("[CRON] start")
    await cleanMessages()
    await cleanLinkCodes()
    await cleanSessions()
    await cleanAuditLog()
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
}

export async function cleanLinkCodes() {
  logger.info(`[CRON] START(cleanLinkCodes)`)

  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)

  try {
    const deleted = await DB.delete(SCHEMA.TG.link).where(lt(SCHEMA.TG.link.createdAt, yesterday)).returning()
    logger.info(`[CRON] END(cleanLinkCodes) deleted ${deleted.length} link code(s).`)
  } catch (err) {
    logger.error(err, "[CRON] cleanLinkCodes")
  }
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

export async function cleanSessions() {
  logger.info(`[CRON] START(cleanSessions) retention days = ${SESSIONS_RETENTION_DAYS}`)

  const expiredBefore = new Date()
  expiredBefore.setDate(expiredBefore.getDate() - SESSIONS_RETENTION_DAYS)
  try {
    const deleted = await DB.delete(SCHEMA.AUTH.session)
      .where(lt(SCHEMA.AUTH.session.expiresAt, expiredBefore))
      .returning({ id: SCHEMA.AUTH.session.id })
    logger.info(`[CRON] END(cleanSessions) deleted ${deleted.length} session(s).`)
  } catch (err) {
    logger.error(err, "[CRON] cleanSessions")
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
