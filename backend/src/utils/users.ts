import z from "zod"
import type { SCHEMA } from "@/db"
import { Cipher } from "./cipher"

const userCipher = new Cipher("tg.users")

export const TgUserSchema = z.object({
  id: z.number(),
  firstName: z.string().max(64),
  lastName: z.string().max(64).optional(),
  username: z.string().max(32).optional(),
  isBot: z.boolean(),
  langCode: z.string().max(35).optional(),
})

export async function decryptUser(dbUser: typeof SCHEMA.TG.users.$inferSelect): Promise<z.infer<typeof TgUserSchema>> {
  const [firstName, lastName, username] = await Promise.all([
    userCipher.decrypt(dbUser.firstName),
    dbUser.lastName ? userCipher.decrypt(dbUser.lastName) : undefined,
    dbUser.username ? userCipher.decrypt(dbUser.username) : undefined,
  ])

  return {
    id: dbUser.userId,
    firstName,
    lastName,
    username,
    isBot: dbUser.isBot,
    langCode: dbUser.langCode ?? undefined,
  }
}

export async function encryptUser(tgUser: z.infer<typeof TgUserSchema>): Promise<typeof SCHEMA.TG.users.$inferInsert> {
  const [firstName, lastName, username] = await Promise.all([
    tgUser.firstName,
    tgUser.lastName ? userCipher.encrypt(tgUser.lastName) : undefined,
    tgUser.username ? userCipher.encrypt(tgUser.username) : undefined,
  ])

  return {
    firstName,
    lastName,
    username,
    userId: tgUser.id,
    langCode: tgUser.langCode ?? null,
    isBot: tgUser.isBot,
  }
}
