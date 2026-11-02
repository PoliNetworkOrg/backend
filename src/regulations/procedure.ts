import type { DraftKind, Procedure, StateKey } from "./contract"

/**
 * Procedures are configuration per document type (spec decision 10): states, transitions, who may take them, what
 * they require, and deadlines. Votes, oppositions and discussion happen outside the dashboard; this only tracks them.
 */

/** Who may take a transition: a regulations permission, or (`rectify`) the permission or a delega. */
export type Actor = "write" | "manage" | "rectify"

export type TransitionRule = {
  from: StateKey
  to: StateKey
  label: string
  kinds: DraftKind[]
  who: Actor
  /** `parses`: the text must parse; `delibera`: the approval data must be given. */
  requires: ("parses" | "delibera")[]
  /**
   * - `freeze`: the text is frozen (sent to approval) and the LLM diff generated;
   * - `reopen`: back to editing;
   * - `approve`: the delibera is recorded;
   * - `emanate`: not a plain transition: "Emana e notifica" runs the emanation, which ends in this state.
   */
  effect: "freeze" | "reopen" | "approve" | "emanate"
}

export type DeadlineRule = {
  key: string
  label: string
  days: number
  severity: "warning" | "info"
  /** Counted from the delibera date (approval) or from the notification. */
  from: "delibera" | "notification"
  /** Shown while the draft is in one of these states. */
  states: StateKey[]
  kinds: DraftKind[]
}

export type ProcedureConfig = {
  key: string
  states: { key: StateKey; label: string; editable: boolean }[]
  transitions: TransitionRule[]
  deadlines: DeadlineRule[]
}

/** Raccolta dei Regolamenti Interni (RRI, Regolamento Fondamentale: "Emanazione dei Regolamenti"). */
const RRI: ProcedureConfig = {
  key: "rri",
  states: [
    { key: "bozza", label: "Bozza", editable: true },
    { key: "in_approvazione", label: "In approvazione", editable: false },
    { key: "approvata", label: "Approvata", editable: false },
    { key: "emanata", label: "Emanata", editable: false },
  ],
  transitions: [
    {
      from: "bozza",
      to: "in_approvazione",
      label: "Invia in approvazione",
      kinds: ["modifica"],
      who: "write",
      requires: ["parses"],
      effect: "freeze",
    },
    {
      from: "in_approvazione",
      to: "bozza",
      label: "Riporta in bozza",
      kinds: ["modifica"],
      who: "write",
      requires: [],
      effect: "reopen",
    },
    {
      from: "in_approvazione",
      to: "approvata",
      label: "Registra l'approvazione",
      kinds: ["modifica"],
      who: "manage",
      requires: ["delibera"],
      effect: "approve",
    },
    {
      from: "approvata",
      to: "emanata",
      label: "Emana e notifica",
      kinds: ["modifica"],
      who: "manage",
      requires: [],
      effect: "emanate",
    },
    {
      from: "bozza",
      to: "emanata",
      label: "Emana rettifica",
      kinds: ["rettifica"],
      who: "rectify",
      requires: ["parses"],
      effect: "emanate",
    },
  ],
  deadlines: [
    {
      key: "emanazione",
      label: "Emanazione entro 3 giorni dall'approvazione",
      days: 3,
      severity: "warning",
      from: "delibera",
      states: ["approvata"],
      kinds: ["modifica"],
    },
    {
      key: "opposizione",
      label: "Termine di 10 giorni per pareri contrari e ricorsi",
      days: 10,
      severity: "info",
      from: "notification",
      states: ["emanata"],
      kinds: ["modifica", "rettifica"],
    },
  ],
}

export const PROCEDURES: Record<string, ProcedureConfig> = { rri: RRI }

export function procedureOf(key: string): ProcedureConfig {
  const procedure = PROCEDURES[key]
  if (!procedure) throw new Error(`Unknown procedure ${key}`)
  return procedure
}

/** The contract's view of a procedure. */
export function procedureView(config: ProcedureConfig): Procedure {
  return {
    key: config.key,
    states: config.states,
    transitions: config.transitions.map(({ from, to, label, kinds }) => ({ from, to, label, kinds })),
    deadlines: config.deadlines.map(({ key, label, days, severity }) => ({ key, label, days, severity })),
  }
}

/** The end of `date` + `days` in Italy (the deadlines are calendar days). */
export function deadlineAt(date: string, days: number): Date {
  const [y, m, d] = date.split("-").map(Number)
  const target = new Date(Date.UTC(y, m - 1, d + days, 23, 59, 59))
  // Europe/Rome's offset on that day, so 23:59:59 is local time.
  const offset = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Rome", timeZoneName: "longOffset" })
    .formatToParts(target)
    .find((p) => p.type === "timeZoneName")?.value
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(offset ?? "")
  const minutes = match ? (match[1] === "+" ? 1 : -1) * (Number(match[2]) * 60 + Number(match[3])) : 60
  return new Date(target.getTime() - minutes * 60_000)
}

/** Today's date in Italy, `YYYY-MM-DD`. */
export function todayInItaly(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(now)
}
