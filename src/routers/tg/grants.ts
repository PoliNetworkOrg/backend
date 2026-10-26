import { TRPCError } from "@trpc/server"
import { and, eq, gt, inArray, isNull } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { describeActor } from "@/idp/actor-info"
import { ACT_AS_SCOPE } from "@/idp/auth"
import { botReadOrDashboard, dashboard } from "@/idp/policies"
import { logger } from "@/logger"
import { WSS } from "@/server"
import { createTRPCRouter, policy } from "@/trpc"
import { activeGrantByUser, type Grant, listGrants } from "@/utils/grants"
import { decryptUser } from "@/utils/users"

const s = SCHEMA.TG

async function withUsers(grants: Grant[]) {
  const ids = [...new Set(grants.map((grant) => grant.userId))]
  const users = ids.length ? await DB.select().from(s.users).where(inArray(s.users.userId, ids)) : []
  const byId = new Map(users.map((user) => [user.userId, user]))
  return Promise.all(
    grants.map(async (grant) => {
      const user = byId.get(grant.userId)
      return { grant, user: user ? await decryptUser(user).catch(() => null) : null }
    })
  )
}

export default createTRPCRouter({
  checkUser: policy(botReadOrDashboard("tg:grants:read"))
    .input(z.object({ userId: z.number() }))
    .output(
      z.object({
        isGranted: z.boolean(),
        grant: z.nullable(
          z.object({
            /** @deprecated Always null: grants are made by IdP subjects. Use `grantedBySub`. */
            grantedBy: z.null(),
            grantedBySub: z.string(),
            validSince: z.date(),
            validUntil: z.date(),
          })
        ),
      })
    )
    .query(async ({ input }) => {
      const grant = (await activeGrantByUser([input.userId])).get(input.userId)
      if (!grant) return { isGranted: false, grant: null }

      const { grantedBy, grantedBySub, validSince, validUntil } = grant
      return { isGranted: true, grant: { grantedBy, grantedBySub, validSince, validUntil } }
    }),

  /**
   * Escalating write: dashboard users only, never the bot acting for someone (RFC v3 §8.1). The
   * grantor is the token's user.
   */
  create: policy(dashboard("tg:grants:manage"), { tokenOnly: true })
    .input(
      z.object({
        userId: z.number(),
        since: z.date(),
        until: z.date(),
        reason: z.string().optional(),
        sendTgLog: z.boolean().default(false),
      })
    )
    .output(
      z.union([
        z.object({
          success: z.literal(true),
          error: z.null(),
        }),
        z.object({
          success: z.literal(false),
          error: z.enum(["ALREADY_EXISTING", "UNAUTHORIZED", "INVALID_PERIOD", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      const { actor } = ctx
      if (actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })

      try {
        if (input.since >= input.until) return { success: false, error: "INVALID_PERIOD" }

        if ((await activeGrantByUser([input.userId])).has(input.userId))
          return { success: false, error: "ALREADY_EXISTING" }

        await DB.insert(s.grants).values({
          telegramUserId: input.userId,
          validSince: input.since,
          validUntil: input.until,
          reason: input.reason,
          grantedBySub: actor.sub,
          grantedViaClient: actor.client,
        })

        if (input.sendTgLog) {
          const author = await describeActor(actor)
          await WSS.logGrantCreate({
            userId: input.userId,
            adminId: author.telegramId ? Number(author.telegramId) : null,
            actor: author,
            validSince: input.since,
            validUntil: input.until,
            reason: input.reason,
          })
        }

        return { success: true, error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing create in tg.grants router")
        return { success: false, error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  /**
   * De-escalating write: the bot's 🛑 button acting for a Telegram user, or the dashboard. Who
   * interrupted is the token's actor.
   */
  interrupt: policy(
    {
      telegram: { scope: ACT_AS_SCOPE, permission: "tg:grants:manage" },
      ...dashboard("tg:grants:manage"),
    },
    { tokenOnly: true }
  )
    .input(
      z.object({
        userId: z.number(),
        sendTgLog: z.boolean().default(false),
      })
    )
    .output(
      z.union([
        z.object({
          success: z.literal(true),
          error: z.null(),
        }),
        z.object({
          success: z.literal(false),
          error: z.enum(["NOT_FOUND", "UNAUTHORIZED", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      const { actor } = ctx
      if (actor.kind === "service") throw new TRPCError({ code: "FORBIDDEN" })

      try {
        const now = new Date()
        // Ends every unexpired grant of the user.
        const interrupted = await DB.update(s.grants)
          .set({
            interruptedAt: now,
            interruptedBySub: actor.sub,
            interruptedByTgId: actor.telegramId === null ? null : Number(actor.telegramId),
          })
          .where(
            and(eq(s.grants.telegramUserId, input.userId), gt(s.grants.validUntil, now), isNull(s.grants.interruptedAt))
          )
          .returning({ id: s.grants.id })

        if (interrupted.length === 0)
          return {
            success: false,
            error: "NOT_FOUND",
          }

        if (input.sendTgLog) {
          const author = await describeActor(actor)
          await WSS.logGrantInterrupt({
            userId: input.userId,
            adminId: author.telegramId ? Number(author.telegramId) : null,
            actor: author,
          })
        }

        return { success: true, error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing interrupt in tg.grants router")
        return { success: false, error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  getOngoing: policy(dashboard("tg:grants:read")).query(async () => {
    return { grants: await withUsers(await listGrants("active")) }
  }),

  getScheduled: policy(dashboard("tg:grants:read")).query(async () => {
    return { grants: await withUsers(await listGrants("scheduled")) }
  }),
})
