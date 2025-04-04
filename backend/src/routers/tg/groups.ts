import { DB, SCHEMA } from "@/db";
import { createTRPCRouter, publicProcedure } from "@/trpc";
import { and, eq, ilike } from "drizzle-orm";
import { z } from "zod";

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const results = await DB.select().from(SCHEMA.TG.groups);
    return results;
  }),

  search: publicProcedure
    .input(
      z.object({
        query: z.string(),
      }),
    )
    .query(async ({ input }) => {
      return await DB.select()
        .from(SCHEMA.TG.groups)
        .where((t) =>
          and(...input.query.split(" ").map((q) => ilike(t.title, `%${q}%`))),
        );
    }),

  getById: publicProcedure
    .input(
      z.object({
        telegramId: z.number(),
      }),
    )
    .query(async ({ input }) => {
      return await DB.select()
        .from(SCHEMA.TG.groups)
        .limit(1)
        .where((t) => eq(t.telegramId, input.telegramId));
    }),

  create: publicProcedure
    .input(
      z.array(
        z.object({
          title: z.string(),
          telegramId: z.number(),
          link: z.string().url(),
        }),
      ),
    )
    .mutation(async ({ input }) => {
      const rows = await DB.insert(SCHEMA.TG.groups)
        .values(input)
        .returning();
      return rows.map((r) => r.id);
    }),
});
