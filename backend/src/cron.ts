import { Cron } from "croner";
import { logger } from "./logger";
import { MESSAGES_RETENTION_DAYS } from "./constants";
import { DB, SCHEMA } from "./db";
import { lt } from "drizzle-orm";

export function cron() {
  new Cron("0 23 4 * * *", async () => {
    logger.info("[CRON] start");
    await cleanMessages();
    await cleanLinkCodes();
    logger.info("[CRON] end");
  });

  logger.info("[CRON] scheduled");
}

async function cleanLinkCodes() {
  logger.info(`[CRON] START(cleanLinkCodes)`);

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  try {
    const deleted = await DB.delete(SCHEMA.TG.link)
      .where(lt(SCHEMA.TG.messages.createdAt, yesterday))
      .returning();
    logger.info(
      `[CRON] END(cleanLinkCodes) deleted ${deleted.length} link code(s).`,
    );
  } catch (err) {
    logger.error(err, "[CRON] cleanLinkCodes");
  }
}

async function cleanMessages() {
  logger.info(
    `[CRON] START(cleanMessages) retention days = ${MESSAGES_RETENTION_DAYS}`,
  );

  const daysAgo = new Date();
  daysAgo.setDate(daysAgo.getDate() - MESSAGES_RETENTION_DAYS);
  try {
    const deleted = await DB.delete(SCHEMA.TG.messages)
      .where(lt(SCHEMA.TG.messages.timestamp, daysAgo))
      .returning();
    logger.info(
      `[CRON] END(cleanMessages) deleted ${deleted.length} message(s).`,
    );
  } catch (err) {
    logger.error(err, "[CRON] cleanMessages");
  }
}
