import { Cron } from "croner"
import { lt } from "drizzle-orm"
import { MESSAGES_RETENTION_DAYS } from "./constants"
import { DB, SCHEMA } from "./db"
import { env } from "./env"
import { logger } from "./logger"

export function cron() {
  new Cron("0 23 4 * * *", async () => {
    logger.info("[CRON] start")
    await cleanMessages()
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
