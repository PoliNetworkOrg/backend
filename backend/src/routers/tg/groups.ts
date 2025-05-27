import { DB, SCHEMA } from "@/db";
import { createTRPCRouter, publicProcedure } from "@/trpc";
import { and, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod/v4";

const GROUPS = SCHEMA.TG.groups;
export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const results = await DB.select().from(GROUPS);
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
        .from(GROUPS)
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
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(t.telegramId, input.telegramId));
    }),

  create: publicProcedure
    .input(
      z.array(
        z.object({
          title: z.string(),
          telegramId: z.number(),
          link: z.url({ hostname: /^t\.me$/ }),
        }),
      ),
    )
    .output(z.array(z.number()))
    .mutation(async ({ input }) => {
      const rows = await DB.insert(GROUPS)
        .values(input)
        .onConflictDoUpdate({
          target: GROUPS.telegramId,
          set: {
            title: sql.raw(`excluded.${GROUPS.title.name}`),
            link: sql.raw(`excluded.${GROUPS.link.name}`),
          },
        })
        .returning();
      return rows.map((r) => r.telegramId);
    }),

  delete: publicProcedure
    .input(
      z.object({
        telegramId: z.number(),
      }),
    )
    .output(z.boolean())
    .mutation(async ({ input }) => {
      const rows = await DB.delete(GROUPS)
        .where(eq(GROUPS.telegramId, input.telegramId))
        .returning();
      return rows.length === 1;
    }),
});
