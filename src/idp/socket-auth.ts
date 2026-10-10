import { AuthKitError, type VerifiedToken } from "@polinetwork/auth-kit"
import { SCOPE } from "./policies"

export type SocketAuth =
  /** No token: the legacy query-type identification, while `LEGACY_ANONYMOUS=allow`. */
  | { kind: "anonymous" }
  /** The bot, until its token expires (epoch ms). */
  | { kind: "token"; client: string; expiresAt: number }
  | { kind: "rejected"; reason: string }

/** Checks the bearer token the bot sends in the socket.io handshake's `auth.token`. */
export async function authenticateSocket(
  token: unknown,
  verify: ((token: string) => Promise<VerifiedToken>) | null,
  botClientId: string | undefined
): Promise<SocketAuth> {
  if (token === undefined || token === null) return { kind: "anonymous" }
  if (typeof token !== "string" || token.length === 0) return { kind: "rejected", reason: "Malformed token" }
  if (!verify) return { kind: "rejected", reason: "Token authentication is not configured" }
  if (!botClientId) return { kind: "rejected", reason: "Telegram bot client is not configured" }

  let verified: VerifiedToken
  try {
    verified = await verify(token)
  } catch (error) {
    if (error instanceof AuthKitError) return { kind: "rejected", reason: error.message }
    throw error
  }
  if (verified.kind !== "service" || verified.clientId !== botClientId)
    return { kind: "rejected", reason: "Only the Telegram bot may connect" }
  if (!verified.scopes.has(SCOPE.tgEvents)) return { kind: "rejected", reason: "Missing scope" }
  const exp = verified.claims.exp
  if (typeof exp !== "number") return { kind: "rejected", reason: "Token without expiry" }
  return { kind: "token", client: verified.clientId, expiresAt: exp * 1000 }
}
