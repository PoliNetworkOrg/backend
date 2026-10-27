import { TRPCError } from "@trpc/server"
import { and, desc, eq, ilike, lt, or, type SQL } from "drizzle-orm"
import { z } from "zod"
import { telegramNames, userNames } from "@/audit/names"
import { DB, SCHEMA } from "@/db"
import { AUDIT_OUTCOME } from "@/db/schema/common/audit-events"
import { env } from "@/env"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const EVENTS = SCHEMA.COMMON.auditEvents

/** The first segment of an action: where in the ecosystem the change was made. */
export const AUDIT_AREAS = ["web", "tg", "wa", "groups", "azure", "esign", "auth"] as const

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`)

export const auditRouter = createTRPCRouter({
  /**
   * Every change made through the backend, newest first: who made it, on what, the state before and after, and the
   * outcome. Pages with `cursor`, the `nextCursor` of the previous page.
   */
  list: policy(dashboard("audit:read"))
    .input(
      z.object({
        cursor: z.number().int().positive().optional(),
        limit: z.number().int().min(1).max(100).default(50),
        area: z.enum(AUDIT_AREAS).optional(),
        outcome: z.enum(Object.values(AUDIT_OUTCOME)).optional(),
        /** Matched against the action, the target, the reason and the error. */
        search: z.string().trim().max(100).optional(),
        target: z.object({ type: z.string().min(1), id: z.string().min(1) }).optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      // The legacy path only serves the dashboard's agent mode, in development.
      if (ctx.actor === null && env.NODE_ENV !== "development") throw new TRPCError({ code: "UNAUTHORIZED" })
      const conditions: SQL[] = []
      if (input.cursor) conditions.push(lt(EVENTS.id, input.cursor))
      if (input.area) conditions.push(ilike(EVENTS.action, `${input.area}.%`))
      if (input.outcome) conditions.push(eq(EVENTS.outcome, input.outcome))
      if (input.target) conditions.push(eq(EVENTS.targetType, input.target.type), eq(EVENTS.targetId, input.target.id))
      if (input.search) {
        const pattern = `%${escapeLike(input.search)}%`
        const matches = or(
          ilike(EVENTS.action, pattern),
          ilike(EVENTS.targetLabel, pattern),
          ilike(EVENTS.targetId, pattern),
          ilike(EVENTS.reason, pattern),
          ilike(EVENTS.error, pattern)
        )
        if (matches) conditions.push(matches)
      }

      const rows = await DB.select()
        .from(EVENTS)
        .where(and(...conditions))
        .orderBy(desc(EVENTS.id))
        .limit(input.limit + 1)
      const page = rows.slice(0, input.limit)

      const subs = [...new Set(page.flatMap((row) => (row.actorSub ? [row.actorSub] : [])))]
      const telegramIds = new Set(page.flatMap((row) => (row.actorTgId === null ? [] : [row.actorTgId])))
      for (const row of page)
        if (row.targetType === "tg.user" && row.targetId && Number.isSafeInteger(Number(row.targetId)))
          telegramIds.add(Number(row.targetId))
      const [people, telegram] = await Promise.all([userNames(subs), telegramNames([...telegramIds])])

      return {
        events: page.map((row) => ({
          ...row,
          actorName:
            (row.actorSub ? people.get(row.actorSub) : undefined) ??
            (row.actorTgId === null ? undefined : telegram.get(row.actorTgId)) ??
            null,
          targetLabel:
            row.targetLabel ?? (row.targetType === "tg.user" ? (telegram.get(Number(row.targetId)) ?? null) : null),
        })),
        nextCursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
      }
    }),
})
