import { eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { DecryptError } from "@/utils/cipher"
import { upsertMultipleSetSql } from "@/utils/db"
import { decryptUser, encryptUser, TgUserSchema } from "@/utils/users"

const s = SCHEMA.TG
const upsertSet = upsertMultipleSetSql(s.users, ["firstName", "lastName", "username", "langCode", "isBot"])

export default createTRPCRouter({
  get: publicProcedure
    .input(z.object({ userId: z.number() }))
    .output(
      z.union([
        z.object({
          user: TgUserSchema,
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

        const user = await decryptUser(res[0])

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
    .input(z.object({ users: z.array(TgUserSchema) }))
    .output(
      z.union([
        z.object({
          error: z.union([z.null(), z.enum(["INTERNAL_SERVER_ERROR", "ENCRYPT_ERROR"])]),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      try {
        const users = await Promise.all(input.users.map(encryptUser))

        const res = await DB.insert(s.users)
          .values(users)
          .onConflictDoUpdate({
            target: s.users.userId,
            set: upsertSet,
          })
          .returning()

        if (!res || res.length === 0) return { error: "INTERNAL_SERVER_ERROR" }

        return { error: null }
      } catch (error) {
        if (error instanceof DecryptError) {
          logger.error(error, "error while encrypting a telegram user from table tg.users")
          return { error: "ENCRYPT_ERROR" }
        }

        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),
})
