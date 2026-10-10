import { TRPCError } from "@trpc/server"
import { and, eq, gt, inArray, isNull } from "drizzle-orm"
import { z } from "zod"
import { USER_ROLE } from "@/constants"
import { DB, SCHEMA } from "@/db"
import type { TUserRole } from "@/db/schema/tg/permissions"
import { describeActor } from "@/idp/actor-info"
import { ACT_AS_SCOPE } from "@/idp/auth"
import { botReadOrDashboard, dashboard } from "@/idp/policies"
import { logger } from "@/logger"
import { WSS } from "@/server"
import { createTRPCRouter, policy } from "@/trpc"
import { activeGrantByUser, type Grant, listGrants } from "@/utils/grants"
import { decryptUser } from "@/utils/users"

const s = SCHEMA.TG

/** Legacy path only: token callers need `tg:grants:manage` instead. */
const CAN_MANAGE_GRANTS: TUserRole[] = [USER_ROLE.PRESIDENT, USER_ROLE.OWNER, USER_ROLE.DIRETTIVO] as const

async function legacyCanManageGrants(telegramId: number) {
  const q = await DB.select().from(s.permissions).where(eq(s.permissions.userId, telegramId)).limit(1)
  return q.length === 1 && q[0].roles.some((role) => CAN_MANAGE_GRANTS.includes(role))
}

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
            /** Telegram ID of a legacy grantor; null for grants made through the IdP. */
            grantedBy: z.number().nullable(),
            grantedBySub: z.string().nullable(),
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

  /** Escalating write: dashboard users only, never the bot acting for someone (RFC v3 §8.1). */
  create: policy(dashboard("tg:grants:manage"))
    .input(
      z.object({
        userId: z.number(),
        /** Legacy callers only; token callers are taken from the token. */
        adderId: z.number().optional(),
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
      if (actor && actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
      if (!actor && input.adderId === undefined)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Missing adderId" })

      try {
        if (!actor && !(await legacyCanManageGrants(input.adderId as number)))
          return { success: false, error: "UNAUTHORIZED" }
        if (actor && input.since >= input.until) return { success: false, error: "INVALID_PERIOD" }

        if ((await activeGrantByUser([input.userId])).has(input.userId))
          return { success: false, error: "ALREADY_EXISTING" }

        if (actor) {
          await DB.insert(s.grantsV2).values({
            telegramUserId: input.userId,
            validSince: input.since,
            validUntil: input.until,
            reason: input.reason,
            grantedBySub: actor.sub,
            grantedViaClient: actor.client,
          })
        } else {
          await DB.insert(s.grants).values({
            userId: input.userId,
            grantedBy: input.adderId as number,
            validUntil: input.until,
            validSince: input.since,
            reason: input.reason,
          })
        }

        if (input.sendTgLog) {
          const author = await describeActor(actor, input.adderId)
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

  /** De-escalating write: the bot's 🛑 button acting for a Telegram user, or the dashboard. */
  interrupt: policy({
    telegram: { scope: ACT_AS_SCOPE, permission: "tg:grants:manage" },
    ...dashboard("tg:grants:manage"),
  })
    .input(
      z.object({
        userId: z.number(),
        /** Legacy callers only; token callers are taken from the token. */
        interruptedById: z.number().optional(),
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
      if (actor?.kind === "service") throw new TRPCError({ code: "FORBIDDEN" })
      if (!actor && input.interruptedById === undefined)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Missing interruptedById" })

      try {
        if (!actor && !(await legacyCanManageGrants(input.interruptedById as number)))
          return { success: false, error: "UNAUTHORIZED" }

        const now = new Date()
        const interruptedByTgId = actor ? (actor.telegramId === null ? null : Number(actor.telegramId)) : null
        // Ends every unexpired grant of the user, in both tables.
        const [legacy, current] = await DB.transaction(async (tx) =>
          Promise.all([
            tx
              .update(s.grants)
              .set(actor ? { interruptedAt: now } : { interruptedBy: input.interruptedById, interruptedAt: now })
              .where(
                and(
                  eq(s.grants.userId, input.userId),
                  gt(s.grants.validUntil, now),
                  isNull(s.grants.interruptedBy),
                  isNull(s.grants.interruptedAt)
                )
              )
              .returning({ id: s.grants.id }),
            tx
              .update(s.grantsV2)
              .set({
                interruptedAt: now,
                interruptedBySub: actor?.sub ?? null,
                interruptedByTgId: actor ? interruptedByTgId : (input.interruptedById as number),
              })
              .where(
                and(
                  eq(s.grantsV2.telegramUserId, input.userId),
                  gt(s.grantsV2.validUntil, now),
                  isNull(s.grantsV2.interruptedAt)
                )
              )
              .returning({ id: s.grantsV2.id }),
          ])
        )

        if (legacy.length + current.length === 0)
          return {
            success: false,
            error: "NOT_FOUND",
          }

        if (input.sendTgLog) {
          const author = await describeActor(actor, input.interruptedById)
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
