import { randomBytes } from "node:crypto"
import { and, eq, gt, isNull, lt } from "drizzle-orm"
import { collabTickets } from "@/db/schema/regulations"
import type { DraftRole, PersonRef } from "../contract"
import { type RegulationsDb, sha256 } from "../db"

/** About a minute: enough to open the websocket, too short to be worth stealing. */
export const TICKET_TTL_MS = 60_000

export type Ticket = { draftId: string; user: PersonRef; role: DraftRole; readOnly: boolean }

/** A single-use ticket for one collaborative connection, bound to one draft and one role. Only its hash is stored. */
export async function issueTicket(db: RegulationsDb, ticket: Ticket, now = new Date()) {
  const secret = randomBytes(32).toString("base64url")
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS)
  await db.insert(collabTickets).values({ hash: sha256(secret), ...ticket, expiresAt })
  // Old tickets are useless: drop them as we go.
  await db.delete(collabTickets).where(lt(collabTickets.expiresAt, new Date(now.getTime() - 3_600_000)))
  return { ticket: secret, expiresAt }
}

/** Uses a ticket up: valid once, before it expires, for its draft only. */
export async function consumeTicket(db: RegulationsDb, secret: string, draftId: string): Promise<Ticket | null> {
  if (typeof secret !== "string" || secret.length < 20 || secret.length > 100) return null
  const [row] = await db
    .update(collabTickets)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(collabTickets.hash, sha256(secret)),
        eq(collabTickets.draftId, draftId),
        isNull(collabTickets.usedAt),
        gt(collabTickets.expiresAt, new Date())
      )
    )
    .returning()
  return row ? { draftId: row.draftId, user: row.user, role: row.role, readOnly: row.readOnly } : null
}
