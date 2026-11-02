import { eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { notifications } from "@/db/schema/regulations"
import type { RegulationsDb } from "../db"

/**
 * Every notification is recorded before it is sent and marked sent after (time, recipients): proof that the Soci and
 * the Direttivo were notified, and idempotency, since a key that was sent is never sent again.
 */
export async function sendOnce(
  db: RegulationsDb,
  record: {
    key: string
    channel: "email" | "telegram"
    kind: string
    recipients: string[]
    subject?: string | null
    draftId?: string | null
    delegaId?: string | null
  },
  /** Gets the notification's id, stable across retries: an idempotency key for the receiver. */
  send: (notificationId: string) => Promise<void>,
  now: () => Date = () => new Date()
): Promise<"sent" | "already"> {
  await db
    .insert(notifications)
    .values({
      id: nanoid(16),
      key: record.key,
      draftId: record.draftId ?? null,
      delegaId: record.delegaId ?? null,
      channel: record.channel,
      kind: record.kind,
      recipients: record.recipients,
      subject: record.subject ?? null,
      status: "pending",
      createdAt: now(),
    })
    .onConflictDoNothing()
  const [row] = await db.select().from(notifications).where(eq(notifications.key, record.key))
  if (row.status === "sent") return "already"
  try {
    await send(row.id)
  } catch (error) {
    await db
      .update(notifications)
      .set({
        status: "failed",
        attempts: row.attempts + 1,
        error: error instanceof Error ? error.message : String(error),
      })
      .where(eq(notifications.key, record.key))
    throw error
  }
  await db
    .update(notifications)
    .set({ status: "sent", attempts: row.attempts + 1, error: null, sentAt: now(), recipients: record.recipients })
    .where(eq(notifications.key, record.key))
  return "sent"
}

/** Escapes text for Telegram's HTML parse mode. */
export const telegramEscape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
