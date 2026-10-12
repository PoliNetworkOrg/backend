import { count, eq, sql } from "drizzle-orm"
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

/** The calendar day a user was first stored, in the association's time zone ("2026-10-11"). */
const creationDay = sql<string>`to_char(${s.users.createdAt} AT TIME ZONE 'Europe/Rome', 'YYYY-MM-DD')`

const CreationHistorySchema = z.union([
  z.object({
    days: z.array(z.object({ date: z.string(), count: z.number().int().nonnegative() })),
    error: z.null(),
  }),
  z.object({
    error: z.literal("INTERNAL_SERVER_ERROR"),
    days: z.null().optional(),
  }),
])

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

  /**
   * How many Telegram users were first stored on each day, from `created_at`, oldest day first. Days without new users
   * are omitted. Only dates and counts leave the database: the dashboard charts user growth without loading or
   * decrypting the users themselves. New procedures take tokens only (no legacy anonymous path).
   */
  getCreationHistory: policy(dashboard("tg:users:read"), { tokenOnly: true })
    .output(CreationHistorySchema)
    .query(async () => {
      try {
        const days = await DB.select({ date: creationDay, count: count() })
          .from(s.users)
          .groupBy(creationDay)
          .orderBy(creationDay)

        return { days, error: null }
      } catch (error) {
        logger.error(error, "error while counting telegram users by creation day")
        return { error: "INTERNAL_SERVER_ERROR" as const }
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
