import type { Actor } from "@polinetwork/auth-kit"
import { TRPCError } from "@trpc/server"

/** Who a write is attributed to: the IdP subject of the token's user. */
export type Author = { sub: string }

/** The author of a dashboard write (RFC v3 §9.1, §9.4): always the token's user. */
export function authorOf(actor: Actor): Author {
  if (actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN", message: "Only dashboard users author content" })
  return { sub: actor.sub }
}

export const createdByColumns = (author: Author) => ({ createdBySub: author.sub })
/** Clears the legacy Telegram ID of an older modifier, so the row names only its last one. */
export const modifiedByColumns = (author: Author) => ({ legacyModifiedByTgId: null, modifiedBySub: author.sub })
