import { eq, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { Cipher, DecryptError } from "@/utils/cipher"

const cipher = new Cipher("tg.users")
const s = SCHEMA.TG

const updatableCols: Readonly<(keyof typeof s.users.$inferInsert)[]> = [
  "firstName",
  "username",
  "lastName",
  "langCode",
  "isBot",
] as const

const addUserUpdateSet = updatableCols.reduce<Partial<Record<(typeof updatableCols)[number], SQL<unknown>>>>(
  (acc, curr) => {
    acc[curr] = sql.raw(`excluded.${s.users[curr].name}`)
    return acc
  },
  {}
)
//

const UserSchema = z.object({
  id: z.number(),
  firstName: z.string().max(64),
  lastName: z.string().max(64).optional(),
  username: z.string().max(32).optional(),
  isBot: z.boolean(),
  langCode: z.string().max(35).optional(),
})

export default createTRPCRouter({
  get: publicProcedure
    .input(z.object({ userId: z.number() }))
    .output(
      z.union([
        z.object({
          user: UserSchema,
          error: z.null(),
        }),
        z.object({
          error: z.enum(["NOT_FOUND", "INTERNAL_SERVER_ERROR", "DECRYPT_ERROR"]),
          user: z.null().optional(),
        }),
      ])
    )
    .query(async ({ input }) => {
      try {
        const res = await DB.select().from(s.users).where(eq(s.users.userId, input.userId)).limit(1)
        if (res.length === 0) return { error: "NOT_FOUND" }

        const [firstName, lastName, username] = await Promise.all([
          await cipher.decrypt(res[0].firstName),
          res[0].lastName ? await cipher.decrypt(res[0].lastName) : undefined,
          res[0].username ? await cipher.decrypt(res[0].username) : undefined,
        ])

        const user: z.infer<typeof UserSchema> = {
          id: res[0].userId,
          firstName,
          lastName,
          username,
          langCode: res[0].langCode ?? undefined,
          isBot: res[0].isBot,
        }

        return {
          user,
          error: null,
        }
      } catch (error) {
        if (error instanceof DecryptError) {
          logger.error(error, "error while decrypting a telegram user from table tg.users")
          return { error: "DECRYPT_ERROR" }
        }

        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  add: publicProcedure
    .input(z.object({ users: z.array(UserSchema) }))
    .output(
      z.union([
        z.object({
          error: z.union([z.null(), z.enum(["INTERNAL_SERVER_ERROR", "ENCRYPT_ERROR"])]),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        const users: (typeof s.users.$inferInsert)[] = await Promise.all(
          input.users.map(async (u) => ({
            userId: u.id,
            firstName: await cipher.encrypt(u.firstName),
            lastName: u.lastName ? await cipher.encrypt(u.lastName) : undefined,
            username: u.username ? await cipher.encrypt(u.username) : undefined,
            isBot: u.isBot,
            langCode: u.langCode,
          }))
        )

        const res = await DB.insert(s.users)
          .values(users)
          .onConflictDoUpdate({
            target: s.users.userId,
            set: addUserUpdateSet,
          })
          .returning()

        if (!res || res.length === 0) return { error: "INTERNAL_SERVER_ERROR" }

        return { error: null }
      } catch (error) {
        logger.error(error, "error while updating a telegram user into table tg.users")
        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),
})
