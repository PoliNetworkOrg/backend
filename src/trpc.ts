import type { AccessSnapshotClient, Actor } from "@polinetwork/auth-kit"
import { initTRPC, TRPCError } from "@trpc/server"
import superjson from "superjson"
import { ZodError, z } from "zod/v4"
import type { RequestAuth } from "./idp/auth"
import { logger } from "./logger"

export type Context = {
  /** Set by the HTTP adapter. Direct callers (tests, scripts) are anonymous. */
  auth?: RequestAuth
  /** Permission source for token callers; null denies every permission. */
  access?: Pick<AccessSnapshotClient, "has" | "current" | "subjectBySub" | "subjectByTelegramId" | "status"> | null
  /** RFC v3 §13: whether requests without a token may take the legacy path. Default "allow". */
  legacyAnonymous?: "allow" | "deny"
}

/**
 * What one actor kind needs to call a procedure (RFC v3 §8): the client's scope (any of the
 * listed ones), and for people also a permission from the access snapshot.
 */
export type PolicyRule = { scope: string | readonly string[]; permission?: string }

/** Actor kinds a procedure accepts. A kind that is not listed is denied. */
export type Policy = { service?: PolicyRule; telegram?: PolicyRule; user?: PolicyRule }

type Meta = {
  /** `"legacy"`: anonymous legacy callers only, until the procedure is migrated or removed. */
  policy?: Policy | "legacy"
  /** New procedures have no legacy behaviour, so anonymous callers are refused. */
  tokenOnly?: boolean
}

const t = initTRPC
  .context<Context>()
  .meta<Meta>()
  .create({
    transformer: superjson,
    errorFormatter({ shape, error }) {
      return {
        ...shape,
        data: {
          ...shape.data,
          zodError: error.cause instanceof ZodError ? z.treeifyError(error.cause) : null,
        },
      }
    },
  })

export const createTRPCRouter = t.router

/**
 * Middleware for timing procedure execution and adding an artificial delay in development.
 *
 * You can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 * network latency that would occur in production but not in local development.
 */
const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now()

  if (t._config.isDev) {
    // artificial delay in dev
    const waitMs = Math.floor(Math.random() * 100) + 100
    await new Promise((resolve) => setTimeout(resolve, waitMs))
  }

  const result = await next()

  const end = Date.now()
  logger.debug(`[TRPC] ${path} took ${end - start}ms to execute`)

  return result
})

/** Mounts that RFC v3 §8 removes; their procedures stay reachable only on the legacy path. */
const LEGACY_ONLY_MOUNTS = ["tg.groupLabels."]

/** What handlers see: the enforced actor, or null on the legacy anonymous path. */
type ActorContext = { actor: Actor | null; can: (permission: string) => boolean }

const REJECTION_CODES = { 401: "UNAUTHORIZED", 403: "FORBIDDEN", 503: "SERVICE_UNAVAILABLE" } as const

function deny(path: string, actor: Actor, reason: string, permission?: string): never {
  logger.warn(
    { procedure: path, actorKind: actor.kind, client: actor.client, permission, reason },
    "[AUTH] authorization denied"
  )
  throw new TRPCError({ code: "FORBIDDEN", message: reason })
}

/**
 * Deny-by-default enforcement (RFC v3 §8). A procedure without a policy is refused at runtime,
 * and a test walks the router so it never ships. Token callers are fully enforced and anything
 * they send as an actor field is ignored by migrated handlers; anonymous callers take the
 * legacy path while `LEGACY_ANONYMOUS=allow`, and every such call is logged.
 */
const enforcePolicy = t.middleware(async ({ ctx, meta, path, next }) => {
  const policy = meta?.policy
  if (!policy) {
    logger.error({ procedure: path }, "[AUTH] procedure without a policy")
    throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Procedure without a policy" })
  }
  const auth = ctx.auth ?? { kind: "anonymous" }

  if (auth.kind === "rejected") throw new TRPCError({ code: REJECTION_CODES[auth.status], message: auth.reason })

  if (auth.kind === "anonymous") {
    if (meta.tokenOnly || (ctx.legacyAnonymous ?? "allow") !== "allow") throw new TRPCError({ code: "UNAUTHORIZED" })
    logger.info({ procedure: path }, "[AUTH] legacy anonymous call")
    const legacy: ActorContext = { actor: null, can: () => false }
    return next({ ctx: legacy })
  }

  const { actor, scopes } = auth
  if (policy === "legacy" || LEGACY_ONLY_MOUNTS.some((mount) => path.startsWith(mount)))
    deny(path, actor, "Not available to token callers")
  const rule = policy[actor.kind]
  if (!rule) deny(path, actor, `Not available to ${actor.kind} callers`)
  const accepted = typeof rule.scope === "string" ? [rule.scope] : rule.scope
  if (!accepted.some((scope) => scopes.has(scope))) deny(path, actor, "Missing scope")
  const can = (permission: string) => ctx.access?.has(actor, permission) ?? false
  if (rule.permission && !can(rule.permission)) deny(path, actor, "Missing permission", rule.permission)

  const enforced: ActorContext = { actor, can }
  return next({ ctx: enforced })
})

const baseProcedure = t.procedure.use(timingMiddleware)

/** A procedure with its RFC v3 §8 policy. Every procedure must be built from this or `legacyProcedure`. */
export function policy(rules: Policy, options: { tokenOnly?: boolean } = {}) {
  return baseProcedure.meta({ policy: rules, ...options }).use(enforcePolicy)
}

/** Reachable only by anonymous legacy callers: not yet migrated, or removed in Phase 5. */
export const legacyProcedure = baseProcedure.meta({ policy: "legacy" }).use(enforcePolicy)
