import type { TRPCError } from "@trpc/server"
import {
  AUDIT_ACTOR_KIND,
  AUDIT_OUTCOME,
  type AuditJson,
  type auditEvents,
  type TAuditActorKind,
  type TAuditOutcome,
} from "@/db/schema/common/audit-events"
import type { RequestAuth } from "@/idp/auth"

export type AuditEvent = typeof auditEvents.$inferInsert

/**
 * What a change was made to; `label` is a readable name, kept as it was at the time. `id` is null when the call acts
 * on several records, which are then named in the input.
 */
export type AuditTarget = { type: string; id: string | number | null; label?: string | null }

export type AuditActor = { kind: TAuditActorKind; sub?: string | null; tgId?: number | null; client?: string | null }

/** What only the handler knows about its change. Each call adds to or replaces the previous fields. */
export type AuditNote = {
  /** Replaces the procedure path. */
  action?: string
  target?: AuditTarget
  before?: unknown
  after?: unknown
  reason?: string | null
}

export type AuditRecorder = {
  set: (note: AuditNote) => void
  /** Records nothing for this call, e.g. a retry that changed nothing. */
  skip: () => void
}

/**
 * Mutations that are not changes made by someone: the bot's high-volume ingestion and per-visit syncs. Moderation the
 * bot reports is kept in `tg_audit_log`, under its own retention rules, and not copied here.
 */
export const UNAUDITED = new Set(["tg.messages.add", "tg.users.add", "tg.auditLog.record", "esign.profile.sync"])

/**
 * Areas that keep their own history, readable with their own permissions: their events name the actor, the action,
 * the target and the outcome, without the input or the state before and after.
 *
 * Temporary: a per-procedure `audit` option in the procedure meta replaces this list.
 */
const MINIMAL_AREAS = [{ prefix: "people.", targetType: "people.person" }]

/** Handed to queries, which change nothing. */
export const noAudit: AuditRecorder = { set: () => {}, skip: () => {} }

export function auditRecorder() {
  const note: AuditNote = {}
  let skipped = false
  const recorder: AuditRecorder = {
    set: (next) => Object.assign(note, next),
    skip: () => {
      skipped = true
    },
  }
  return { recorder, note, skipped: () => skipped }
}

/** Field names that hold secrets: whole names, or the last word of a camelCase name (`idempotencyKey`). */
const SECRET_KEY = /^(pass(word)?|passwd|secret|token|ticket|otp|code|key)$|(Pass(word)?|Secret|Token|Ticket|Otp|Key)$/
const MAX_STRING = 2000
const MAX_ITEMS = 100
const MAX_DEPTH = 8
/** A copy longer than this, as JSON, is replaced by a note of its size. */
const MAX_JSON = 64 * 1024

function copyOf(value: unknown, depth: number): AuditJson {
  if (value === null || value === undefined) return null
  if (typeof value === "string")
    return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} characters)` : value
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value)
  if (typeof value === "boolean") return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof File) return { file: value.name, type: value.type, size: value.size }
  if (value instanceof Blob) return { file: null, type: value.type, size: value.size }
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return `(${value.byteLength} bytes)`
  if (depth >= MAX_DEPTH) return "(nested too deep)"
  if (value instanceof FormData) return copyOf(Object.fromEntries(value.entries()), depth)
  if (value instanceof Map) return copyOf(Object.fromEntries(value), depth)
  if (value instanceof Set) return copyOf([...value], depth)
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => copyOf(item, depth + 1))
    return value.length > MAX_ITEMS ? [...items, `(${value.length - MAX_ITEMS} more)`] : items
  }
  if (typeof value === "object") {
    const entries = Object.entries(value).filter(([, item]) => item !== undefined && typeof item !== "function")
    const copy: { [key: string]: AuditJson } = {}
    for (const [key, item] of entries.slice(0, MAX_ITEMS))
      copy[key] = SECRET_KEY.test(key) ? "(hidden)" : copyOf(item, depth + 1)
    if (entries.length > MAX_ITEMS) copy["(more)"] = `${entries.length - MAX_ITEMS} more fields`
    return copy
  }
  return null
}

/**
 * A JSON copy of an input or a row, safe to keep: secrets are replaced, files and bytes are described instead of copied,
 * and long strings, arrays, objects and copies are cut.
 */
export function auditJson(value: unknown): AuditJson {
  const copy = copyOf(value, 0)
  const size = JSON.stringify(copy)?.length ?? 0
  return size > MAX_JSON ? `(${size} characters, too large to keep)` : copy
}

function actorOf(auth: RequestAuth | undefined): AuditActor | null {
  if (auth?.kind !== "token") return null
  const { actor } = auth
  if (actor.kind === "service") return { kind: AUDIT_ACTOR_KIND.SERVICE, client: actor.client }
  return {
    kind: actor.kind,
    sub: actor.sub,
    tgId: actor.telegramId === null ? null : Number(actor.telegramId),
    client: actor.client,
  }
}

/** An error a handler returned instead of throwing, e.g. `{ error: "NOT_FOUND" }`, `{ success: false }` or `false`. */
function returnedError(data: unknown): string | null {
  if (data === false) return "Nothing changed"
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null
  if ("error" in data && typeof data.error === "string") return data.error
  if ("success" in data && data.success === false) return "Not successful"
  return null
}

const DENIED_CODES = new Set<TRPCError["code"]>(["UNAUTHORIZED", "FORBIDDEN"])

type Result = { ok: true; data: unknown } | { ok: false; error: TRPCError }

const MAX_ERROR = 500

/**
 * The root cause's message, on one line: a database error then reads "violates foreign key constraint …" rather than
 * the failed query with its parameters.
 */
function errorMessage(error: Error) {
  let cause = error
  while (cause.cause instanceof Error) cause = cause.cause
  return (cause.message.split("\n")[0] ?? "").slice(0, MAX_ERROR)
}

function outcomeOf(result: Result): { outcome: TAuditOutcome; error: string | null } {
  if (!result.ok)
    return {
      outcome: DENIED_CODES.has(result.error.code) ? AUDIT_OUTCOME.DENIED : AUDIT_OUTCOME.FAILURE,
      error: errorMessage(result.error),
    }
  const error = returnedError(result.data)
  return error === null ? { outcome: AUDIT_OUTCOME.SUCCESS, error: null } : { outcome: AUDIT_OUTCOME.FAILURE, error }
}

/** The first of `keys` that `value` holds as a string or a number. */
function idIn(value: unknown, keys: string[]): string | null {
  if (value === null || typeof value !== "object") return null
  for (const key of keys) {
    const id = (value as Record<string, unknown>)[key]
    if (typeof id === "string" || typeof id === "number") return String(id)
  }
  return null
}

/**
 * The event for one mutation, or null when there is nothing worth keeping: calls refused before an actor was known
 * (no token, an invalid token) would let anyone fill the log.
 */
export function auditEvent(options: {
  path: string
  auth: RequestAuth | undefined
  requestId?: string | null
  rawInput: unknown
  note: AuditNote
  result: Result
}): AuditEvent | null {
  const { path, auth, note, result } = options
  const actor = actorOf(auth)
  if (!actor) return null
  const { outcome, error } = outcomeOf(result)

  const event: AuditEvent = {
    action: note.action ?? path,
    requestId: options.requestId ?? null,
    actorKind: actor.kind,
    actorSub: actor.sub ?? null,
    actorTgId: actor.tgId ?? null,
    actorClient: actor.client ?? null,
    targetType: note.target?.type ?? null,
    targetId: note.target?.id == null ? null : String(note.target.id),
    targetLabel: note.target?.label ?? null,
    reason: note.reason ?? null,
    outcome,
    error,
    // A refused call changed nothing, and its input is whatever the caller chose to send.
    input: outcome === AUDIT_OUTCOME.DENIED ? null : auditJson(options.rawInput),
    before: note.before === undefined ? null : auditJson(note.before),
    after: note.after === undefined ? null : auditJson(note.after),
  }

  const minimal = MINIMAL_AREAS.find((area) => path.startsWith(area.prefix))
  if (!minimal) return event
  const id = idIn(options.rawInput, ["personId", "id"]) ?? (result.ok ? idIn(result.data, ["personId", "id"]) : null)
  return {
    ...event,
    targetType: minimal.targetType,
    targetId: id,
    targetLabel: null,
    reason: null,
    input: null,
    before: null,
    after: null,
  }
}
