import { and, arrayContains, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { ARRAY_USER_ROLE, type TUserRole, USER_ROLE } from "@/db/schema/tg/permissions"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const s = SCHEMA.TG

const CAN_SELF_ASSIGN: TUserRole[] = [USER_ROLE.PRESIDENT, USER_ROLE.OWNER]
const CAN_ASSIGN: TUserRole[] = [USER_ROLE.PRESIDENT, USER_ROLE.OWNER, USER_ROLE.DIRETTIVO]
const CAN_ADD_BOT: TUserRole[] = [USER_ROLE.HR, USER_ROLE.OWNER, USER_ROLE.CREATOR, USER_ROLE.DIRETTIVO]

export default createTRPCRouter({
  getRoles: publicProcedure.input(z.object({ userId: z.number() })).query(async ({ input }) => {
    const [res] = await DB.select({
      roles: s.permissions.roles,
    })
      .from(s.permissions)
      .where(eq(s.permissions.userId, input.userId))
      .limit(1)

    return {
      userId: input.userId,
      roles: res ? res.roles : "user",
    }
  }),

  addRole: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        role: z.enum(ARRAY_USER_ROLE),
        adderId: z.number(),
      })
    )
    .output(
      z.object({
        error: z.union([
          z.null(),
          z.enum(["UNAUTHORIZED", "UNAUTHORIZED_SELF_ASSIGN", "DUPLICATE_ROLE", "INTERNAL_SERVER_ERROR"]),
        ]),
      })
    )
    .mutation(async ({ input }) => {
      try {
        // get current permissions of adder and target
        const q = await DB.select()
          .from(s.permissions)
          .where(inArray(s.permissions.userId, [input.userId, input.adderId]))

        const adder = q.find((e) => e.userId === input.adderId)
        const existing = q.find((e) => e.userId === input.userId)

        // check if adder is not in permission table or doesn't have permissions
        if (!adder || !adder.roles.some((a) => CAN_ASSIGN.includes(a))) return { error: "UNAUTHORIZED" }

        // if adder is self-assigning roles, he must be president or owner (ref CAN_SELF_ASSIGN)
        if (adder.userId === input.userId && !adder.roles.some((a) => CAN_SELF_ASSIGN.includes(a)))
          return { error: "UNAUTHORIZED_SELF_ASSIGN" }

        // president and owner are special role
        // only owners can perform this role update
        if ((input.role === "president" || input.role === "owner") && !adder.roles.includes("owner"))
          return { error: "UNAUTHORIZED" }

        // check if it's the first time the target is added to permissions table
        if (!existing) {
          await DB.insert(s.permissions).values({
            userId: input.userId,
            roles: input.role === "president" ? [input.role, "direttivo"] : [input.role],
            addedBy: input.adderId,
          })
          return { error: null }
        }

        // if target already has this role, skip
        if (existing.roles.includes(input.role)) return { error: "DUPLICATE_ROLE" }

        // we must check if there's already a president and change it
        if (input.role === "president") {
          const qOldPres = await DB.select()
            .from(s.permissions)
            .where(arrayContains(s.permissions.roles, ["president"]))

          if (qOldPres.length === 1) {
            logger.warn("Role: an owner is changing the current president of PoliNetwork")
            // TODO: send email warning to adminorg email
            await DB.update(s.permissions)
              .set({ roles: qOldPres[0].roles.filter((r) => r !== "president") })
              .where(eq(s.permissions.userId, qOldPres[0].userId))
          }

          // to avoid another mutation, we directly add "direttivo"
          if (!existing.roles.includes("direttivo")) {
            existing.roles.push("direttivo")
          }
        }

        // here we finally make the update
        // first we push the new role to the roles array
        existing.roles.push(input.role)
        // then we update the DB entry with the updated roles array
        await DB.update(s.permissions)
          .set({
            roles: existing.roles,
          })
          .where(eq(s.permissions.userId, input.userId))
        return { error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing addRole in tg.permissions router")
        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  checkGroup: publicProcedure.input(z.object({ userId: z.number(), groupId: z.number() })).query(async ({ input }) => {
    const res = await DB.$count(
      s.groupAdmins,
      and(eq(s.groupAdmins.userId, input.userId), eq(s.groupAdmins.groupId, input.groupId))
    )

    return res !== 0
  }),

  addGroup: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        adderId: z.number(),
        groupId: z.number(),
      })
    )
    .query(async ({ input }) => {
      await DB.insert(s.groupAdmins)
        .values({
          userId: input.userId,
          groupId: input.groupId,
          addedBy: input.adderId,
        })
        .onConflictDoNothing()
    }),

  canAddBot: publicProcedure
    .input(
      z.object({
        userId: z.number(),
      })
    )
    .output(
      z.union([
        z.object({ allowed: z.boolean(), error: z.null() }),
        z.object({
          allowed: z.literal(false),
          error: z.enum(["NOT_FOUND"]),
        }),
      ])
    )
    .query(async ({ input }) => {
      const res = await DB.select({ roles: s.permissions.roles })
        .from(s.permissions)
        .where(eq(s.permissions.userId, input.userId))
        .limit(1)

      if (!res[0]) return { error: "NOT_FOUND", allowed: false }
      const allowed = res[0].roles.some((r) => CAN_ADD_BOT.includes(r))

      return { error: null, allowed }
    }),
})
