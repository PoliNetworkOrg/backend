import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { Cipher, DecryptError } from "@/utils/cipher"

const cipher = new Cipher("tg.messages")

const s = SCHEMA.TG
const message = z.object({
  chatId: z.number(),
  messageId: z.number(),
  authorId: z.number(),
  message: z.string(),
  timestamp: z.date(),
  group: z
    .object({
      title: z.string(),
      inviteLink: z.string().nullable(),
    })
    .optional(),
})
type Message = z.infer<typeof message>

function padChatId(chatId: number): number {
  if (chatId < 0) return chatId

  const str = chatId.toString()
  if (str.length === 13) return -chatId

  const padding = `1${"0".repeat(12 - str.length)}`

  // Prepend the padding to the input string
  return parseInt(`-${padding}${chatId}`, 10)
}

export default createTRPCRouter({
  get: publicProcedure
    .input(z.object({ chatId: z.number(), messageId: z.number() }))
    .output(
      z.union([
        z.object({ message, error: z.null() }),
        z.object({
          message: z.null().optional(),
          error: z.enum(["NOT_FOUND", "DECRYPT_ERROR", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .query(async ({ input }) => {
      const [res] = await DB.select()
        .from(s.messages)
        .where(and(eq(s.messages.chatId, padChatId(input.chatId)), eq(s.messages.messageId, input.messageId)))
        .limit(1)

      if (!res) return { message: null, error: "NOT_FOUND" }

      try {
        const encryptedMessage = cipher.decrypt(res.message)
        const message: Message = {
          message: encryptedMessage,
          timestamp: res.timestamp,
          authorId: res.authorId,
          chatId: res.chatId,
          messageId: res.messageId,
        }

        return { message, error: null }
      } catch (error) {
        if (error instanceof DecryptError) {
          logger.error(error, "error while decrypting a telegram message")
          return { message: null, error: "DECRYPT_ERROR" }
        }

        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),

  add: publicProcedure
    .input(z.object({ messages: z.array(message) }))
    .output(z.object({ error: z.union([z.null(), z.enum(["ENCRYPT_ERROR"])]) }))
    .mutation(async ({ input }) => {
      try {
        const messages = input.messages.map(async (m) => ({
          ...m,
          message: cipher.encrypt(m.message),
        }))
        const awaitedMessages = await Promise.all(messages)
        await DB.insert(s.messages).values(awaitedMessages).onConflictDoNothing()
        return { error: null }
      } catch (err) {
        logger.error(
          err,
          `error while encrypting ${input.messages.length > 1 ? "some telegram messages" : "a telegam message"}`
        )
        return { error: "ENCRYPT_ERROR" }
      }
    }),

  getLastByUser: publicProcedure
    .input(z.object({ userId: z.number() }))
    .output(
      z.union([
        z.object({ messages: z.array(message), error: z.null() }),
        z.object({
          messages: z.null().optional(),
          error: z.enum(["NOT_FOUND", "DECRYPT_ERROR", "INTERNAL_SERVER_ERROR"]),
        }),
      ])
    )
    .query(async ({ input }) => {
      const res = await DB.select()
        .from(s.messages)
        .where(eq(s.messages.authorId, input.userId))
        .leftJoin(SCHEMA.TG.groups, eq(s.messages.chatId, SCHEMA.TG.groups.telegramId))
        .limit(10)

      if (!res) return { messages: null, error: "NOT_FOUND" }

      try {
        const messages = res.map(({ messages: e, groups: group }) => {
          const decryptedMessage = cipher.decrypt(e.message)
          const message: Message = {
            message: decryptedMessage,
            timestamp: e.timestamp,
            authorId: e.authorId,
            chatId: e.chatId,
            messageId: e.messageId,
            group: group
              ? {
                  title: group.title,
                  inviteLink: group.link,
                }
              : undefined,
          }
          return message
        })

        return { messages, error: null }
      } catch (error) {
        if (error instanceof DecryptError) {
          logger.error(error, "error while decrypting a telegram message")
          return { message: null, error: "DECRYPT_ERROR" }
        }

        return { error: "INTERNAL_SERVER_ERROR" }
      }
    }),
})
