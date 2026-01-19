import { and, eq, gte, isNull, lte } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { type TUserRole, USER_ROLE } from "@/db/schema/tg/permissions"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const s = SCHEMA.TG

const CAN_MANAGE_GRANTS: TUserRole[] = [USER_ROLE.PRESIDENT, USER_ROLE.OWNER, USER_ROLE.DIRETTIVO] as const

export default createTRPCRouter({
  checkUser: publicProcedure
    .input(z.object({ userId: z.number() }))
    .output(
      z.object({
        isGranted: z.boolean(),
        grant: z.nullable(
          z.object({
            grantedBy: z.number(),
            validSince: z.date(),
            validUntil: z.date(),
          })
        ),
      })
    )
    .query(async ({ input }) => {
      const now = new Date()
      const res = await DB.select({
        grantedBy: s.grants.grantedBy,
        validSince: s.grants.validSince,
        validUntil: s.grants.validUntil,
      })
        .from(s.grants)
        .where(
          and(
            eq(s.grants.userId, input.userId),
            lte(s.grants.validSince, now),
            gte(s.grants.validUntil, now),
            isNull(s.grants.interruptedBy)
          )
        )
        .limit(1)

      if (res.length === 0) return { isGranted: false, grant: null }

      return {
        isGranted: true,
        grant: res[0],
      }
    }),

  create: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        adderId: z.number(),
        since: z.date(),
        until: z.date(),
        reason: z.string().optional(),
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
          error: z.enum(["ALREADY_EXISTING", "UNAUTHORIZED", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        // get current permissions of adder and target
        const q = await DB.select().from(s.permissions).where(eq(s.permissions.userId, input.adderId)).limit(1)

        // check if adder is not in permission table or doesn't have permissions
        if (!q || q.length !== 1 || q[0].roles.every((a) => !CAN_MANAGE_GRANTS.includes(a)))
          return { success: false, error: "UNAUTHORIZED" }

        const now = new Date()
        const existing = await DB.select({
          grantedBy: s.grants.grantedBy,
          validSince: s.grants.validSince,
          validUntil: s.grants.validUntil,
        })
          .from(s.grants)
          .where(
            and(
              eq(s.grants.userId, input.userId),
              lte(s.grants.validSince, now),
              gte(s.grants.validUntil, now),
              isNull(s.grants.interruptedBy)
            )
          )
          .limit(1)

        if (existing?.length === 1)
          return {
            success: false,
            error: "ALREADY_EXISTING",
          }

        // then we upsert the DB entry with the updated roles array
        await DB.insert(s.grants).values({
          userId: input.userId,
          grantedBy: input.adderId,
          validUntil: input.until,
          validSince: input.since,
          reason: input.reason,
        })

        return { success: true, error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing create in tg.grants router")
        return { success: false, error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  interrupt: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        interruptedById: z.number(),
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
    .mutation(async ({ input }) => {
      try {
        // get current permissions of adder
        const q = await DB.select().from(s.permissions).where(eq(s.permissions.userId, input.interruptedById)).limit(1)

        // check if adder is not in permission table or doesn't have permissions
        if (!q || q.length !== 1 || q[0].roles.every((a) => !CAN_MANAGE_GRANTS.includes(a)))
          return { success: false, error: "UNAUTHORIZED" }

        const now = new Date()
        const affected = await DB.update(s.grants)
          .set({ interruptedBy: input.interruptedById })
          .where(and(eq(s.grants.userId, input.userId), gte(s.grants.validUntil, now), isNull(s.grants.interruptedBy)))
          .returning({ id: s.grants.id })

        if (affected?.length === 0)
          return {
            success: false,
            error: "NOT_FOUND",
          }

        return { success: true, error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing create in tg.grants router")
        return { success: false, error: "INTERNAL_SERVER_ERROR" }
      }
    }),
})
