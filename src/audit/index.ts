import type { TRPCError } from "@trpc/server"
import { ZodError } from "zod/v4"
import {
  AUDIT_ACTOR_KIND,
  AUDIT_OUTCOME,
  type AuditJson,
  type auditEvents,
  type TAuditActorKind,
  type TAuditOutcome,
} from "@/db/schema/common/audit-events"
import type { RequestAuth } from "@/idp/auth"
import type { AuditOption, AuditTarget } from "./option"

export type AuditEvent = typeof auditEvents.$inferInsert
export { type AuditOption, type AuditTarget, type AuditTargetOf, audit } from "./option"

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

/** For a mutation without an option, which the router test keeps from shipping: the option that stores the least. */
export const UNDECLARED: AuditOption = { capture: "minimal" }

/** Handed to queries, which change nothing. */
export const noAudit: AuditRecorder = { set: () => {}, skip: () => {} }

/** A fresh recorder for one mutation, with the note it collects and whether the handler skipped the event. */
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

/** The caller from the verified token; null without one, so such calls are not recorded. */
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

/** Whether the caller lacked the scope or the permission. */
export const isDenied = (result: Result) => !result.ok && DENIED_CODES.has(result.error.code)

/** Target ids, labels and reasons can come from the caller, so they are cut like strings in copies. */
const cut = (value: string | null) => (value === null ? null : (copyOf(value, 0) as string))

const MAX_ERROR = 500

/**
 * The root cause's message, on one line: a database error then reads "violates foreign key constraint …" rather than
 * the failed query with its parameters, and an invalid input lists its issues rather than their JSON.
 */
function errorMessage(error: Error) {
  let cause = error
  while (cause.cause instanceof Error) cause = cause.cause
  if (cause instanceof ZodError)
    return cause.issues
      .map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ")
      .slice(0, MAX_ERROR)
  return (cause.message.split("\n")[0] ?? "").slice(0, MAX_ERROR)
}

/** Success, failure or denial, from a thrown error or an error the handler returned. */
function outcomeOf(result: Result): { outcome: TAuditOutcome; error: string | null } {
  if (!result.ok)
    return {
      outcome: DENIED_CODES.has(result.error.code) ? AUDIT_OUTCOME.DENIED : AUDIT_OUTCOME.FAILURE,
      error: errorMessage(result.error),
    }
  const error = returnedError(result.data)
  return error === null ? { outcome: AUDIT_OUTCOME.SUCCESS, error: null } : { outcome: AUDIT_OUTCOME.FAILURE, error }
}

/** Only `fields` of a copied input, when it is an object. */
function onlyFields(copy: AuditJson, fields: readonly string[] | undefined): AuditJson {
  if (!fields || copy === null || typeof copy !== "object" || Array.isArray(copy)) return copy
  return Object.fromEntries(fields.flatMap((field) => (field in copy ? [[field, copy[field] ?? null]] : [])))
}

/**
 * The event for one mutation, or null when there is nothing worth keeping: calls refused before an actor was known
 * (no token, an invalid token) would let anyone fill the log.
 */
export function auditEvent(options: {
  path: string
  option?: AuditOption
  auth: RequestAuth | undefined
  requestId?: string | null
  rawInput: unknown
  note: AuditNote
  result: Result
}): AuditEvent | null {
  const { path, note, result } = options
  const option = options.option ?? UNDECLARED
  if (option.capture === "none") return null
  const actor = actorOf(options.auth)
  if (!actor) return null
  const { outcome, error } = outcomeOf(result)

  // What the handler names wins over the option's target, which only sees the raw input and the result.
  const target =
    note.target ?? option.target?.({ input: options.rawInput, data: result.ok ? result.data : undefined }) ?? undefined
  const targetId = target?.id == null ? null : String(target.id)
  const event: AuditEvent = {
    action: note.action ?? option.action ?? path,
    requestId: options.requestId ?? null,
    actorKind: actor.kind,
    actorSub: actor.sub ?? null,
    actorTgId: actor.tgId ?? null,
    actorClient: actor.client ?? null,
    targetType: target?.type ?? null,
    targetId: cut(targetId),
    targetLabel: cut(target?.label ?? null),
    reason: null,
    outcome,
    error,
    input: null,
    before: null,
    after: null,
  }
  if (option.capture === "minimal") return event

  return {
    ...event,
    reason: cut(note.reason ?? null),
    // A refused call changed nothing, and its input is whatever the caller chose to send.
    input: outcome === AUDIT_OUTCOME.DENIED ? null : onlyFields(auditJson(options.rawInput), option.fields),
    before: note.before === undefined ? null : auditJson(note.before),
    after: note.after === undefined ? null : auditJson(note.after),
  }
}
