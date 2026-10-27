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

/** What a change was made to; `label` is a readable name, kept as it was at the time. */
export type AuditTarget = { type: string; id: string | number; label?: string | null }

export type AuditActor = { kind: TAuditActorKind; sub?: string | null; tgId?: number | null; client?: string | null }

/** What only the handler knows about its change. Each call adds to or replaces the previous fields. */
export type AuditNote = {
  /** Replaces the procedure path, e.g. `tg.moderation.ban` for moderation the bot reports. */
  action?: string
  /** Replaces the caller, for changes the caller reports on someone else's behalf. */
  actor?: AuditActor
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

/** Mutations that are not changes made by someone: the bot's high-volume ingestion and per-visit syncs. */
export const UNAUDITED = new Set(["tg.messages.add", "tg.users.add", "esign.profile.sync"])

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

const SECRET_KEY = /pass(word)?|secret|token|ticket|otp|code|key$/i
const MAX_STRING = 2000
const MAX_ITEMS = 100
const MAX_DEPTH = 8

/**
 * A JSON copy of an input or a row, safe to keep: secrets are replaced, files and bytes are described instead of copied,
 * and long strings and arrays are cut.
 */
export function auditJson(value: unknown, depth = 0): AuditJson {
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
  if (value instanceof FormData) return auditJson(Object.fromEntries(value.entries()), depth)
  if (value instanceof Map) return auditJson(Object.fromEntries(value), depth)
  if (value instanceof Set) return auditJson([...value], depth)
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => auditJson(item, depth + 1))
    return value.length > MAX_ITEMS ? [...items, `(${value.length - MAX_ITEMS} more)`] : items
  }
  if (typeof value === "object") {
    const copy: { [key: string]: AuditJson } = {}
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function") continue
      copy[key] = SECRET_KEY.test(key) ? "(hidden)" : auditJson(item, depth + 1)
    }
    return copy
  }
  return null
}

/** Input fields in which legacy callers name themselves. */
const LEGACY_ACTOR_FIELDS = [
  "createdBy",
  "modifiedBy",
  "updatedBy",
  "adderId",
  "removerId",
  "interruptedById",
  "performerId",
  "adminId",
]

function legacyTelegramId(input: AuditJson): number | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null
  for (const field of LEGACY_ACTOR_FIELDS) {
    const id = Number(input[field])
    if (input[field] !== undefined && input[field] !== null && Number.isSafeInteger(id)) return id
  }
  return null
}

function actorOf(auth: RequestAuth | undefined, input: AuditJson): AuditActor | null {
  if (auth?.kind === "token") {
    const { actor } = auth
    if (actor.kind === "service") return { kind: AUDIT_ACTOR_KIND.SERVICE, client: actor.client }
    return {
      kind: actor.kind,
      sub: actor.sub,
      tgId: actor.telegramId === null ? null : Number(actor.telegramId),
      client: actor.client,
    }
  }
  if (auth?.kind === "rejected") return null
  return { kind: AUDIT_ACTOR_KIND.LEGACY, tgId: legacyTelegramId(input) }
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
  if (error === null) return { outcome: AUDIT_OUTCOME.SUCCESS, error: null }
  return { outcome: error.startsWith("UNAUTHORIZED") ? AUDIT_OUTCOME.DENIED : AUDIT_OUTCOME.FAILURE, error }
}

/**
 * The event for one mutation, or null when there is nothing worth keeping: calls refused before an actor was known
 * (no token on a closed legacy path, an invalid token) would let anyone fill the log.
 */
export function auditEvent(options: {
  path: string
  auth: RequestAuth | undefined
  rawInput: unknown
  note: AuditNote
  result: Result
}): AuditEvent | null {
  const { path, auth, note, result } = options
  const input = auditJson(options.rawInput)
  const caller = actorOf(auth, input)
  if (!caller) return null
  const { outcome, error } = outcomeOf(result)
  if (outcome === AUDIT_OUTCOME.DENIED && auth?.kind !== "token" && !result.ok) return null

  const actor = note.actor ?? caller
  return {
    action: note.action ?? path,
    actorKind: actor.kind,
    actorSub: actor.sub ?? null,
    actorTgId: actor.tgId ?? null,
    actorClient: actor.client ?? null,
    targetType: note.target?.type ?? null,
    targetId: note.target === undefined ? null : String(note.target.id),
    targetLabel: note.target?.label ?? null,
    reason: note.reason ?? null,
    outcome,
    error,
    input,
    before: note.before === undefined ? null : auditJson(note.before),
    after: note.after === undefined ? null : auditJson(note.after),
  }
}
