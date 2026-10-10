import { eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { botReadOrDashboard, dashboard, SCOPE } from "@/idp/policies"
import { logger } from "@/logger"
import { createTRPCRouter, policy } from "@/trpc"
import { DecryptError } from "@/utils/cipher"
import { upsertMultipleSetSql } from "@/utils/db"
import { decryptUser, encryptUser, TgUserSchema, userCipher } from "@/utils/users"

const s = SCHEMA.TG
const upsertSet = upsertMultipleSetSql(s.users, ["firstName", "lastName", "username", "langCode", "isBot"])

export default createTRPCRouter({
  getAll: policy(dashboard("tg:users:read")).query(async () => {
    try {
      const res = await DB.select().from(s.users)
      const decryptedUsers = await Promise.all(res.map((user) => decryptUser(user).catch(() => null)))

      return {
        users: decryptedUsers.filter((user) => user !== null),
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

  get: policy(botReadOrDashboard("tg:users:read"))
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

  getByUsername: policy(botReadOrDashboard("tg:users:read"))
    .input(z.object({ username: z.string() }))
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
        const encryptedUsername = userCipher.encrypt(input.username.toLowerCase().replace("@", ""))
        const res = await DB.select().from(s.users).where(eq(s.users.username, encryptedUsername)).limit(1)
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

  add: policy({ service: { scope: SCOPE.tgIngest } })
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
