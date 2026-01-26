import { and, arrayContains, eq, inArray, ne as neq, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { ARRAY_USER_ROLE, type TUserRole, USER_ROLE } from "@/db/schema/tg/permissions"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { decryptUser, TgUserSchema } from "@/utils/users"

const s = SCHEMA.TG

const CAN_SELF_ASSIGN: TUserRole[] = [USER_ROLE.PRESIDENT, USER_ROLE.OWNER] as const
const CAN_ASSIGN: TUserRole[] = [USER_ROLE.PRESIDENT, USER_ROLE.OWNER, USER_ROLE.DIRETTIVO] as const
const CAN_ADD_BOT: TUserRole[] = [USER_ROLE.HR, USER_ROLE.OWNER, USER_ROLE.CREATOR, USER_ROLE.DIRETTIVO] as const

const direttivoMember = z.object({
  userId: z.number(),
  user: TgUserSchema.nullable(),
  isPresident: z.boolean(),
})

export default createTRPCRouter({
  getRoles: publicProcedure
    .input(z.object({ userId: z.number() }))
    .output(
      z.object({
        userId: z.number(),
        roles: z.union([z.array(z.string<TUserRole>()), z.null()]),
      })
    )
    .query(async ({ input }) => {
      const [res] = await DB.select({
        roles: s.permissions.roles,
      })
        .from(s.permissions)
        .where(eq(s.permissions.userId, input.userId))
        .limit(1)

      return {
        userId: input.userId,
        roles: res ? res.roles : null,
      }
    }),

  getDirettivo: publicProcedure
    .output(
      z.union([
        z.object({
          members: z.array(direttivoMember),
          error: z.null(),
        }),
        z.object({
          members: z.null().optional(),
          error: z.enum(["EMPTY", "NOT_ENOUGH_MEMBERS", "TOO_MANY_MEMBERS", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .query(async () => {
      try {
        const res = await DB.select({ userId: s.permissions.userId, dbUser: s.users, roles: s.permissions.roles })
          .from(s.permissions)
          .where(arrayContains(s.permissions.roles, [USER_ROLE.DIRETTIVO]))
          .leftJoin(s.users, eq(s.permissions.userId, s.users.userId))

        const members: z.infer<typeof direttivoMember>[] = await Promise.all(
          res
            .toSorted((a, b) => {
              if (a.roles.includes(USER_ROLE.PRESIDENT) && b.roles.includes(USER_ROLE.PRESIDENT)) return 0
              if (a.roles.includes(USER_ROLE.PRESIDENT)) return -1
              if (b.roles.includes(USER_ROLE.PRESIDENT)) return 1
              return 0
            })
            .map(async (r) => {
              const isPresident = r.roles.includes(USER_ROLE.PRESIDENT)
              const user = r.dbUser ? await decryptUser(r.dbUser) : null

              return {
                user,
                userId: r.userId,
                isPresident,
              }
            })
        )

        if (res.length === 0) return { error: "EMPTY" }
        if (res.length < 3) return { error: "NOT_ENOUGH_MEMBERS" }
        if (res.length > 9) return { error: "TOO_MANY_MEMBERS" }

        logger.debug({ members }, "getDirettivo")
        return { error: null, members }
      } catch (error) {
        logger.error({ error }, "Error while executing getDirettivo in tg.permissions router")
        return { error: "INTERNAL_SERVER_ERROR" }
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
      z.union([
        z.object({
          roles: z.array(z.string<TUserRole>()),
          error: z.null(),
        }),
        z.object({
          roles: z.null().optional(),
          error: z.enum(["UNAUTHORIZED", "UNAUTHORIZED_SELF_ASSIGN", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        // get current permissions of adder and target
        const q = await DB.select()
          .from(s.permissions)
          .where(inArray(s.permissions.userId, [input.userId, input.adderId]))

        const adder = q.find((e) => e.userId === input.adderId)

        // check if adder is not in permission table or doesn't have permissions
        if (!adder || !adder.roles.some((a) => CAN_ASSIGN.includes(a))) return { error: "UNAUTHORIZED" }

        // if adder is self-assigning roles, he must be president or owner (ref CAN_SELF_ASSIGN)
        if (adder.userId === input.userId && !adder.roles.some((a) => CAN_SELF_ASSIGN.includes(a)))
          return { error: "UNAUTHORIZED_SELF_ASSIGN" }

        // president and owner are special role
        // only owners can perform this role update
        if (
          (input.role === USER_ROLE.PRESIDENT || input.role === USER_ROLE.OWNER) &&
          !adder.roles.includes(USER_ROLE.OWNER)
        )
          return { error: "UNAUTHORIZED" }

        const existingRoles = q.find((e) => e.userId === input.userId)?.roles ?? []

        // concat is the superpowered push
        const roles = Array.from(
          new Set(
            existingRoles.concat(
              input.role === USER_ROLE.PRESIDENT ? [USER_ROLE.PRESIDENT, USER_ROLE.DIRETTIVO] : input.role
            )
          )
        )

        // we must check if there's already a president and change it
        if (input.role === USER_ROLE.PRESIDENT) {
          const updated = await DB.update(s.permissions)
            .set({ roles: sql`array_remove(${s.permissions.roles}, ${USER_ROLE.PRESIDENT})` })
            .where(
              and(arrayContains(s.permissions.roles, [USER_ROLE.PRESIDENT]), neq(s.permissions.userId, input.userId))
            )
            .returning({ userId: s.permissions.userId })

          if (updated.length > 0) {
            // TODO: send email warning to adminorg email
            logger.warn(
              { adderId: input.adderId, olds: updated.map((e) => e.userId), new: input.userId },
              "Role: an owner is changing the current president of PoliNetwork"
            )
          }
        }

        // then we upsert the DB entry with the updated roles array
        await DB.insert(s.permissions)
          .values({
            userId: input.userId,
            roles,
            addedBy: input.adderId,
          })
          .onConflictDoUpdate({
            target: s.permissions.userId,
            set: {
              roles,
            },
          })

        return { roles, error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing addRole in tg.permissions router")
        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  removeRole: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        role: z.enum(ARRAY_USER_ROLE),
        removerId: z.number(),
      })
    )
    .output(
      z.union([
        z.object({
          roles: z.array(z.string<TUserRole>()),
          error: z.null(),
        }),
        z.object({
          roles: z.null().optional(),
          error: z.union([
            z.null(),
            z.enum(["UNAUTHORIZED", "NOT_FOUND", "UNAUTHORIZED_SELF_ASSIGN", "INTERNAL_SERVER_ERROR"]),
          ]),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        // get current permissions of remover and target
        const q = await DB.select().from(s.permissions).where(eq(s.permissions.userId, input.removerId))
        if (q.length === 0) return { error: "UNAUTHORIZED" }

        const remover = q[0]

        // check if remover is not in permission table or doesn't have permissions
        if (!remover.roles.some((a) => CAN_ASSIGN.includes(a))) return { error: "UNAUTHORIZED" }

        // if remover is self-removing roles, he must be president or owner (ref CAN_SELF_ASSIGN)
        if (remover.userId === input.userId && !remover.roles.some((a) => CAN_SELF_ASSIGN.includes(a)))
          return { error: "UNAUTHORIZED_SELF_ASSIGN" }

        // president and owner are special role
        // only owners can perform this role update
        if (
          (input.role === USER_ROLE.PRESIDENT || input.role === USER_ROLE.OWNER) &&
          !remover.roles.includes(USER_ROLE.OWNER)
        )
          return { error: "UNAUTHORIZED" }

        const affected = await DB.update(s.permissions)
          .set({ roles: sql`array_remove(${s.permissions.roles}, ${input.role})` })
          .where(eq(s.permissions.userId, input.userId))
          .returning({ roles: s.permissions.roles })

        if (affected.length === 0) return { error: "NOT_FOUND" }
        let roles = affected[0].roles

        if (input.role === USER_ROLE.DIRETTIVO) {
          const presAffected = await DB.update(s.permissions)
            .set({ roles: sql`array_remove(${s.permissions.roles}, ${USER_ROLE.PRESIDENT})` })
            .where(eq(s.permissions.userId, input.userId))
            .returning({ roles: s.permissions.roles })

          if (presAffected.length !== 0) roles = presAffected[0].roles
        }

        return { roles, error: null }
      } catch (error) {
        logger.error({ error }, "Error while executing removeRole in tg.permissions router")
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
