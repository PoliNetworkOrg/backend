import type { z } from "zod"
import {
  type CreditConfig,
  type CreditEntry,
  type creditOperationSchema,
  type creditSemesterSchema,
  estimateCost,
  type PromotionContent,
} from "./contract"
import type { PromotionStore } from "./promotions"
import { activeMember, fail, type Record, type Store, type Viewer } from "./service"

/** A ledger row as stored: append-only, the balance is their sum. */
export type StoredCreditEntry = CreditEntry & { associationId: string; authorSub: string }
export type NewCreditEntry = Omit<StoredCreditEntry, "id" | "createdAt" | "associationId">

/** The association's ledger under its lock, handed to operations that may debit or reverse. */
export type Ledger = {
  config: CreditConfig
  entries: StoredCreditEntry[]
  post(entry: NewCreditEntry): void
}
export type CreditStore = {
  config(): Promise<CreditConfig>
  saveConfig(config: CreditConfig, actor: string): Promise<void>
  entries(associationId: string): Promise<StoredCreditEntry[]>
  /**
   * Locks the association's ledger, hands `operation` its entries and records what it posts, unless `key` was used
   * before. Unique constraints also stop a second debit or reversal for the same request.
   */
  post(associationId: string, key: string, operation: (ledger: Ledger, record: Record) => void): Promise<string>
  /** One grant per association and period; returns how many associations received it. */
  semester(
    input: z.infer<typeof creditSemesterSchema>,
    author: { sub: string; name: string },
    associationIds: string[]
  ): Promise<number>
}

export const balanceOf = (entries: { amount: number }[]) => entries.reduce((sum, e) => sum + e.amount, 0)
const programmesOf = (r: Record) => (r.published ?? r.profile).programmes

/**
 * What an approval, a rejection or a withdrawal does to the ledger. With credits on, approval debits the estimated cost
 * (or the cost PoliNetwork sets for channels without one), refusing to go below zero unless allowed; rejection or
 * withdrawal after approval reverses that debit. With credits off nothing is posted.
 */
export function settle(
  ledger: Ledger,
  r: Record,
  v: Viewer,
  promotion: { id: string; content: PromotionContent },
  step: { action: "approve"; cost: number | null } | { action: "release" }
) {
  if (!ledger.config.enabled) return
  const debit = ledger.entries.find((e) => e.kind === "debit" && e.promotionId === promotion.id)
  if (step.action === "release") {
    if (!debit || ledger.entries.some((e) => e.reversesId === debit.id)) return
    ledger.post({
      kind: "reversal",
      amount: -debit.amount,
      reason: `Storno: promozione “${promotion.content.title}” non pubblicata`,
      authorSub: v.sub,
      authorName: v.name,
      promotionId: promotion.id,
      reversesId: debit.id,
      period: null,
    })
    return
  }
  if (debit) return
  const estimate = estimateCost(promotion.content.channels, programmesOf(r), ledger.config)
  if (estimate.unknown && step.cost === null) fail("BAD_REQUEST", "Set the cost: a requested channel has no fixed cost")
  const cost = step.cost ?? estimate.total
  if (cost === 0) return
  if (!ledger.config.allowNegative && balanceOf(ledger.entries) < cost)
    fail("CONFLICT", "The association does not have enough credits")
  ledger.post({
    kind: "debit",
    amount: -cost,
    reason: `Promozione “${promotion.content.title}”`,
    authorSub: v.sub,
    authorName: v.name,
    promotionId: promotion.id,
    reversesId: null,
    period: null,
  })
}

export function createCreditService(
  store: CreditStore,
  registry: Pick<Store, "get" | "list">,
  promotions: Pick<PromotionStore, "promotions">
) {
  const present = (e: StoredCreditEntry): CreditEntry => ({
    id: e.id,
    kind: e.kind,
    amount: e.amount,
    reason: e.reason,
    authorName: e.authorName,
    promotionId: e.promotionId,
    reversesId: e.reversesId,
    period: e.period,
    createdAt: e.createdAt,
  })
  return {
    async account(v: Viewer, associationId: string) {
      const r = await registry.get(associationId)
      if (!r || !(v.operator || activeMember(r, v))) fail("NOT_FOUND", "Association not found")
      const config = await store.config()
      // Representatives see nothing until PoliNetwork turns credits on.
      const entries = config.enabled || v.operator ? await store.entries(associationId) : []
      const waiting = config.enabled ? await promotions.promotions({ associationId, status: "submitted" }) : []
      return {
        enabled: config.enabled,
        balance: balanceOf(entries),
        expected: waiting.reduce((sum, p) => sum + estimateCost(p.content.channels, programmesOf(r), config).total, 0),
        entries: entries.map(present),
        config,
        programmes: programmesOf(r),
      }
    },
    async config(v: Viewer) {
      if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
      return store.config()
    },
    async saveConfig(v: Viewer, config: CreditConfig) {
      if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
      await store.saveConfig(config, v.sub)
    },
    /** A grant or an adjustment by an operator, with its reason. */
    async operate(v: Viewer, input: z.infer<typeof creditOperationSchema>) {
      if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
      if (input.kind === "credit" && input.amount < 0) fail("BAD_REQUEST", "A grant must be positive")
      await store.post(input.associationId, `${v.sub}:${input.commandId}`, (ledger, r) => {
        if (!r.registered) fail("BAD_REQUEST", "Register the association first")
        if (input.amount < 0 && !ledger.config.allowNegative && balanceOf(ledger.entries) + input.amount < 0)
          fail("CONFLICT", "The association does not have enough credits")
        ledger.post({
          kind: input.kind,
          amount: input.amount,
          reason: input.reason,
          authorSub: v.sub,
          authorName: v.name,
          promotionId: null,
          reversesId: null,
          period: null,
        })
      })
      return { id: input.associationId }
    },
    /** The semester's grant to every active registered association, once per period. */
    async semester(v: Viewer, input: z.infer<typeof creditSemesterSchema>) {
      if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
      const active = (await registry.list()).filter((r) => r.registered && r.status === "active").map((r) => r.id)
      return { granted: await store.semester(input, { sub: v.sub, name: v.name }, active) }
    },
  }
}
