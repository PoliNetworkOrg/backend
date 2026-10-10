import type { Actor } from "@polinetwork/auth-kit"
import { eq } from "drizzle-orm"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { decryptUser } from "@/utils/users"
import type { SocketActor } from "@/websocket/telegram"

/** Who performed an action, as the bot shows it in its logs (RFC v3 §8.3). */
export type ActorInfo = SocketActor

async function telegramName(telegramId: string): Promise<string | null> {
  try {
    const [row] = await DB.select()
      .from(SCHEMA.TG.users)
      .where(eq(SCHEMA.TG.users.userId, Number(telegramId)))
      .limit(1)
    if (!row) return null
    const user = await decryptUser(row)
    return [user.firstName, user.lastName].filter(Boolean).join(" ")
  } catch (error) {
    logger.warn({ error }, "[IDP] cannot read the actor's Telegram name")
    return null
  }
}

/** The enforced actor, or on the legacy path the Telegram ID the caller sent. */
export async function describeActor(actor: Actor | null, legacyTelegramId?: number): Promise<ActorInfo> {
  const sub = actor && actor.kind !== "service" ? actor.sub : null
  const telegramId = actor
    ? actor.kind === "service"
      ? null
      : actor.telegramId
    : legacyTelegramId !== undefined
      ? String(legacyTelegramId)
      : null
  const name = telegramId ? await telegramName(telegramId) : null
  return { sub, telegramId, displayName: name ?? telegramId ?? sub ?? actor?.client ?? "unknown" }
}
