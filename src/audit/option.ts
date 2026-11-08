// No imports: routers declare their audit options with this module without loading the database schema.

/**
 * What a change was made to; `label` is a readable name, kept as it was at the time. `id` is null when the call acts
 * on several records, which are then named in the input.
 */
export type AuditTarget = { type: string; id: string | number | null; label?: string | null }

/**
 * The target of a call, from its input and, once it succeeded, its result. The input is the raw one, not yet validated
 * (and undefined for denied calls, whose body is not read), so a target function checks what it takes from it.
 */
export type AuditTargetOf = (call: { input: unknown; data: unknown }) => AuditTarget | null

/**
 * How a mutation is recorded, declared in its procedure meta with `.meta(audit.full())` and the like. A test walks the
 * router so that every mutation declares one.
 */
export type AuditOption =
  /** Not recorded; `why` says why, e.g. the bot's ingestion or an area that keeps its own log. */
  | { capture: "none"; why: string }
  /**
   * The actor, the action, the target and the outcome, without the input, the states or the reason: for areas that
   * keep their own history, readable with their own permissions.
   */
  | { capture: "minimal"; target?: AuditTargetOf; action?: string }
  /**
   * Also the input, the states the handler adds and the reason. `fields` keeps only those fields of the input, for
   * inputs that carry personal data or free text not worth keeping.
   */
  | { capture: "full"; fields?: readonly string[]; target?: AuditTargetOf; action?: string }

/** Procedure meta for each way of recording a mutation. */
export const audit = {
  full: (options: Omit<Extract<AuditOption, { capture: "full" }>, "capture"> = {}) => ({
    audit: { capture: "full", ...options } satisfies AuditOption,
  }),
  minimal: (options: Omit<Extract<AuditOption, { capture: "minimal" }>, "capture"> = {}) => ({
    audit: { capture: "minimal", ...options } satisfies AuditOption,
  }),
  none: (why: string) => ({ audit: { capture: "none", why } satisfies AuditOption }),
}
