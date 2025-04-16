import { DB, SCHEMA } from "@/db";
import { logger } from "@/logger";
import { createTRPCRouter, publicProcedure } from "@/trpc";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

export default createTRPCRouter({
  link: publicProcedure
    .input(
      z.object({
        code: z.string().regex(/^\d+$/).length(6),
        telegramId: z.number(),
        telegramUsername: z
          .string()
          .transform((s) => (s.startsWith("@") ? s.slice(1) : s)),
      }),
    )
    .query(async ({ input }) => {
      try {
        const { code, telegramId, telegramUsername } = input;
        const s = SCHEMA.TG.link;
        const res = await DB.update(s)
          .set({ telegramId })
          .where(
            and(eq(s.code, code), eq(s.telegramUsername, telegramUsername)),
          )
          .returning();

        if (res.length !== 1) return { success: false };

        const u = SCHEMA.AUTH.users;
        await DB.update(u)
          .set({ telegramId, telegramUsername })
          .where(eq(u.id, res[0].userId));

        return { success: true };
      } catch (e) {
        logger.error(
          e,
          "There was an error while linking telegram to user table",
        );
        return { success: false };
      }
    }),
});
