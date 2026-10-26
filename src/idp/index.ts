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
import { z } from "zod"
import { env } from "@/env"
import { logger } from "@/logger"
import { type PeopleRoles, RoleChangeError } from "@/people/roles"
import { authenticate, type RequestAuth } from "./auth"
import { dbPersistence } from "./persistence"

/** The projection this backend reads from the IdP (RFC v3 §5.2). */
const PROJECTION = "backend"
const signerDirectory = z.array(
  z.object({ sub: z.string(), name: z.string(), email: z.string().nullable(), emailVerified: z.boolean().optional() })
)
const peopleDirectory = z.object({
  roles: z.array(z.object({ key: z.string(), name: z.string(), binding: z.string() })),
  users: z.array(
    z.object({
      sub: z.string(),
      name: z.string(),
      email: z.string().nullable(),
      azureId: z.string().nullish(),
      telegramId: z.string().nullable(),
      telegramUsername: z.string().nullable(),
      roles: z.array(z.string()),
      assigned: z.array(z.string()).optional(),
      since: z.record(z.string(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
    })
  ),
})
/** The person's bound roles after a role command, as `POST /api/internal/people-roles` answers. */
const roleResult = z.object({
  roles: peopleDirectory.shape.roles,
  held: z.array(z.string()),
  assigned: z.array(z.string()),
})
/** Lets the backend give and take back the roles bound to People, for the dashboard user it authenticated. */
const PEOPLE_ROLES_SCOPE = "idp:people:roles"

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
    logger.warn("[IDP] Token authentication is not configured: every request is rejected")
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
  let directory: (() => Promise<z.infer<typeof signerDirectory>>) | null = null
  let peopleRoles: PeopleRoles | null = null
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
    directory = async () => {
      const url = new URL("/api/internal/esign-users", endpoints.snapshotUrl)
      const token = await tokens.getToken()
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      })
      if (response.status === 401) tokens.invalidate()
      if (!response.ok) throw new Error(`IdP signer directory returned ${response.status}`)
      return signerDirectory.parse(await response.json())
    }
    // A separate token, so a client not yet granted the write scope still pulls the snapshot.
    const roleTokens = serviceTokenSource({
      clientId: env.OAUTH_BACKEND_CLIENT_ID,
      privateKey: parsePrivateKey(env.OAUTH_BACKEND_PRIVATE_JWK),
      tokenUrl: endpoints.tokenUrl,
      tokenAudience: endpoints.tokenAudience,
      resource: env.OAUTH_INTERNAL_RESOURCE_URI,
      scopes: [PEOPLE_ROLES_SCOPE],
      onError: report("people roles token source"),
    })
    const peopleRolesUrl = new URL("/api/internal/people-roles", endpoints.snapshotUrl)
    peopleRoles = {
      async directory() {
        const token = await tokens.getToken()
        const response = await fetch(peopleRolesUrl, {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        })
        if (response.status === 401) tokens.invalidate()
        if (!response.ok) throw new Error(`IdP People roles returned ${response.status}`)
        return peopleDirectory.parse(await response.json())
      },
      async change(change) {
        const send = async () => {
          let token: string
          try {
            token = await roleTokens.getToken()
          } catch {
            throw new RoleChangeError(
              503,
              `no token to change roles; is ${PEOPLE_ROLES_SCOPE} granted to this backend?`
            )
          }
          try {
            return await fetch(peopleRolesUrl, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
              body: JSON.stringify(change),
              signal: AbortSignal.timeout(10_000),
            })
          } catch {
            throw new RoleChangeError(503, "PoliNetwork Auth could not be reached")
          }
        }
        let response = await send()
        // A stale cached token: ask for a new one and send the same command once more. A second 401 is a refusal.
        if (response.status === 401) {
          roleTokens.invalidate()
          response = await send()
          if (response.status === 401) roleTokens.invalidate()
        }
        if (response.ok) {
          // The command was applied, but without a readable answer People can't confirm it: retry it by ID.
          const result = roleResult.safeParse(await response.json().catch(() => null))
          if (!result.success) throw new RoleChangeError(503, "PoliNetwork Auth sent an unreadable answer")
          return result.data
        }
        const body = (await response.json().catch(() => null)) as { error?: unknown } | null
        throw new RoleChangeError(
          response.status,
          typeof body?.error === "string" ? body.error : `request failed (${response.status})`
        )
      },
    }
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
    directory,
    peopleRoles,
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
