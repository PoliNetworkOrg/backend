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
          message: z.null(),
          error: z.enum(["NOT_FOUND", "DECRYPT_ERROR"]),
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
        const encryptedMessage = await cipher.decrypt(res.message)
        const message: Message = {
          message: encryptedMessage,
          timestamp: res.timestamp,
          authorId: res.authorId,
          chatId: res.chatId,
          messageId: res.messageId,
        }

        return { message, error: null }
      } catch (err) {
        logger.error(err, "error while decrypting a telegram message")
        return { message: null, error: "DECRYPT_ERROR" }
      }
    }),

  add: publicProcedure
    .input(z.object({ messages: z.array(message) }))
    .output(z.object({ error: z.union([z.null(), z.enum(["ENCRYPT_ERROR"])]) }))
    .mutation(async ({ input }) => {
      try {
        const messages = input.messages.map(async (m) => ({
          ...m,
          message: await cipher.encrypt(m.message),
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
})
