import { eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export default createTRPCRouter({
  link: publicProcedure
    .input(
      z.object({
        code: z.string().regex(/^\d+$/).length(6),
        telegramId: z.number(),
        telegramUsername: z.string().transform((s) => (s.startsWith("@") ? s.slice(1) : s)),
      })
    )
    .query(async ({ input }) => {
      try {
        const { code, telegramId, telegramUsername } = input
        const s = SCHEMA.TG.link
        const rows = await DB.select().from(s).where(eq(s.code, code))
        if (!rows || rows.length === 0) return { success: false, error: "Not found" }

        const { userId, telegramUsername: savedTgUsername, ttl, createdAt } = rows[0]
        if (savedTgUsername !== telegramUsername) return { success: false, error: "Username mismatch" }

        if (createdAt.getTime() + ttl * 1000 < Date.now()) return { success: false, error: "Expired code" }

        await DB.update(s).set({ telegramId }).where(eq(s.code, code))

        const u = SCHEMA.AUTH.users
        await DB.update(u) // update the auth.user table
          .set({ telegramId, telegramUsername })
          .where(eq(u.id, userId))

        return { success: true, error: undefined }
      } catch (e) {
        logger.error(e, "There was an unexpected error while linking telegram to user table")
        if (e instanceof Error) return { success: false, error: e.message }
        return { success: false, error: JSON.stringify(e) }
      }
    }),
})
