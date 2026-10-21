import type { Actor } from "@polinetwork/auth-kit"
import { TRPCError } from "@trpc/server"

/**
 * Who a write is attributed to. New writes set only the IdP subject and clear the legacy
 * Telegram ID column, which older rows (and an older release after a rollback) still use.
 */
export type Author = { id: null; sub: string }

/** The author of a dashboard write (RFC v3 §9.1, §9.4): always the token's user. */
export function authorOf(actor: Actor): Author {
  if (actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN", message: "Only dashboard users author content" })
  return { id: null, sub: actor.sub }
}

export const createdByColumns = (author: Author) => ({ createdBy: author.id, createdBySub: author.sub })
export const modifiedByColumns = (author: Author) => ({ modifiedBy: author.id, modifiedBySub: author.sub })
