import {
  ACCESS_READ_SCOPE,
  AuthKitError,
  accessSnapshot,
  createAccessEventHandler,
  createKeyStore,
  idpEndpoints,
  type ServiceTokenSourceOptions,
  serviceTokenSource,
  verifyAccessToken,
} from "@polinetwork/auth-kit"
import { env } from "@/env"
import { logger } from "@/logger"
import { authenticate, type RequestAuth } from "./auth"
import { dbPersistence } from "./persistence"

/** The projection this backend reads from the IdP (RFC v3 §5.2). */
const PROJECTION = "backend"

function report(component: string) {
  return (error: unknown) => {
    // auth-kit errors carry a stable code and never include tokens or keys.
    if (error instanceof AuthKitError) logger.warn({ code: error.code, cause: error.message }, `[IDP] ${component}`)
    else logger.warn({ err: error }, `[IDP] ${component}`)
  }
}

function parsePrivateKey(value: string): ServiceTokenSourceOptions["privateKey"] {
  try {
    return JSON.parse(value)
  } catch {
    throw new Error("OAUTH_BACKEND_PRIVATE_JWK must be a JSON Web Key")
  }
}

function configure() {
  if (!env.IDP_PUBLIC_URL || !env.OAUTH_BACKEND_RESOURCE_URI) {
    logger.warn("[IDP] Token authentication is not configured: only legacy anonymous calls are accepted")
    return null
  }
  const endpoints = idpEndpoints({
    publicUrl: env.IDP_PUBLIC_URL,
    ...(env.IDP_INTERNAL_URL ? { internalUrl: env.IDP_INTERNAL_URL } : {}),
  })
  const audience = env.OAUTH_BACKEND_RESOURCE_URI
  const keyStore = createKeyStore({
    jwksUrl: endpoints.jwksUrl,
    persistence: dbPersistence,
    onError: report("key store"),
  })

  let snapshot = null
  let events = null
  if (env.OAUTH_INTERNAL_RESOURCE_URI && env.OAUTH_BACKEND_CLIENT_ID && env.OAUTH_BACKEND_PRIVATE_JWK) {
    const tokens = serviceTokenSource({
      clientId: env.OAUTH_BACKEND_CLIENT_ID,
      privateKey: parsePrivateKey(env.OAUTH_BACKEND_PRIVATE_JWK),
      tokenUrl: endpoints.tokenUrl,
      tokenAudience: endpoints.tokenAudience,
      resource: env.OAUTH_INTERNAL_RESOURCE_URI,
      scopes: [ACCESS_READ_SCOPE],
      onError: report("token source"),
    })
    snapshot = accessSnapshot({
      url: endpoints.snapshotUrl,
      tokens,
      projection: PROJECTION,
      persistence: dbPersistence,
      pollIntervalMs: env.IDP_SNAPSHOT_POLL_INTERVAL_MS,
      onError: report("access snapshot"),
    })
    events = createAccessEventHandler({
      keyStore,
      issuer: endpoints.issuer,
      audience,
      projection: PROJECTION,
      snapshot,
      onError: report("access events"),
    })
  } else {
    logger.warn("[IDP] Access snapshot is not configured: every permission check denies")
  }

  return {
    keyStore,
    snapshot,
    /** Fetch API handler for `POST /internal/events`, or null without a snapshot. */
    events,
    verify: (token: string) => verifyAccessToken(token, { issuer: endpoints.issuer, audience, keyStore }),
  }
}

export const idp = configure()

/** Loads persisted state, fetches keys and the snapshot once, then refreshes in the background. */
export async function startIdp() {
  if (!idp) return
  await idp.keyStore.start()
  await idp.snapshot?.start()
  logger.info({ keys: idp.keyStore.status(), snapshot: idp.snapshot?.status() ?? null }, "[IDP] started")
}

export function stopIdp() {
  idp?.keyStore.stop()
  idp?.snapshot?.stop()
}

export function authenticateRequest(headers: {
  authorization?: string | null | undefined
  actor?: string | null | undefined
}): Promise<RequestAuth> {
  return authenticate(
    { authorization: headers.authorization ?? null, actor: headers.actor ?? null },
    { verify: idp?.verify ?? null, snapshot: idp?.snapshot ?? null }
  )
}
