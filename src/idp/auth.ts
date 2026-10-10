import {
  type AccessSnapshotClient,
  type Actor,
  AuthKitError,
  resolveActor,
  type VerifiedToken,
} from "@polinetwork/auth-kit"

/** Scope that lets the bot act for a Telegram user through `X-PN-Actor` (RFC v3 §6.3). */
export const ACT_AS_SCOPE = "backend:tg:act-as"

/**
 * How a request authenticated (RFC v3 §6.4, §13):
 * - `anonymous`: no bearer token; the legacy path, while `LEGACY_ANONYMOUS=allow`;
 * - `token`: a verified IdP access token and the actor it resolves to;
 * - `rejected`: a token or actor header was sent but cannot be accepted. Never falls back to legacy.
 */
export type RequestAuth =
  | { kind: "anonymous" }
  | { kind: "token"; actor: Actor; scopes: ReadonlySet<string> }
  | { kind: "rejected"; status: 401 | 403 | 503; reason: string }

export type Authenticator = {
  /** Null when token authentication is not configured. */
  verify: ((token: string) => Promise<VerifiedToken>) | null
  snapshot: Pick<AccessSnapshotClient, "current"> | null
}

// The scheme name is case-insensitive (RFC 7235 §2.1).
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i

export async function authenticate(
  headers: { authorization?: string | null; actor?: string | null },
  authenticator: Authenticator
): Promise<RequestAuth> {
  const { authorization, actor: actorHeader } = headers
  if (!authorization) {
    if (actorHeader != null) return { kind: "rejected", status: 401, reason: "Actor header without a token" }
    return { kind: "anonymous" }
  }
  const token = BEARER.exec(authorization)?.[1]
  if (!token) return { kind: "rejected", status: 401, reason: "Malformed authorization header" }
  if (!authenticator.verify) return { kind: "rejected", status: 401, reason: "Token authentication is not configured" }

  try {
    const verified = await authenticator.verify(token)
    const actor = resolveActor(verified, {
      actorHeader,
      actAsScope: ACT_AS_SCOPE,
      snapshot: authenticator.snapshot?.current() ?? null,
    })
    return { kind: "token", actor, scopes: verified.scopes }
  } catch (error) {
    if (error instanceof AuthKitError) {
      if (error.code === "keys_unavailable")
        return { kind: "rejected", status: 503, reason: "IdP signing keys unavailable" }
      if (error.code === "actor_forbidden") return { kind: "rejected", status: 403, reason: error.message }
      return { kind: "rejected", status: 401, reason: error.message }
    }
    throw error
  }
}
