import type { Actor } from "@polinetwork/auth-kit"
import { TRPCError } from "@trpc/server"

/** Who a write is attributed to: a legacy Telegram ID or an IdP subject, never both. */
export type Author = { id: number | null; sub: string | null }

/**
 * The author of a dashboard write (RFC v3 §9.1, §9.4). Token callers are taken from the token and
 * any actor field they send is ignored; legacy callers still identify themselves by Telegram ID.
 */
export function authorOf(actor: Actor | null, legacyTelegramId: number | undefined): Author {
  if (actor) {
    if (actor.kind !== "user")
      throw new TRPCError({ code: "FORBIDDEN", message: "Only dashboard users author content" })
    return { id: null, sub: actor.sub }
  }
  if (legacyTelegramId === undefined) throw new TRPCError({ code: "BAD_REQUEST", message: "Missing author" })
  return { id: legacyTelegramId, sub: null }
}

export const createdByColumns = (author: Author) => ({ createdBy: author.id, createdBySub: author.sub })
export const modifiedByColumns = (author: Author) => ({ modifiedBy: author.id, modifiedBySub: author.sub })
