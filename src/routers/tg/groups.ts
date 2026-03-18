import { eq, ilike, or, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const GROUPS = SCHEMA.TG.groups
export default createTRPCRouter({
  // TODO: this is performance HEAVY, make it more safe eventually
  // At the moment, this query is used by banall flowProducer in the telegram bot.
  // We may consider moving the flowProducer and ensure connection through the same Redis
  // instance or some other way of bridging the two parts together.
  getAll: publicProcedure.query(async () => {
    const beforeMs = performance.now()
    const results = await DB.select().from(GROUPS)
    const afterMs = performance.now()

    logger.warn({ queryMs: afterMs - beforeMs }, "Call to trpc.tg.groups.getAll, performance monitoring...")
    return results
  }),

  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1).max(100),
        limit: z.number().min(1).max(20).default(6),
      })
    )
    .query(async ({ input }) => {
      const { query, limit } = input

      const likeQuery = query.split(" ").join("%")
      const results = await DB.select({
        telegramId: GROUPS.telegramId,
        title: GROUPS.title,
        tag: GROUPS.tag,
        link: GROUPS.link,
      })
        .from(GROUPS)
        .where((t) => or(ilike(t.title, `%${likeQuery}%`), ilike(t.tag, `%${likeQuery}%`)))
        .orderBy((t) => sql`${t.tag} ASC NULLS LAST`)
        .limit(limit)

      return {
        groups: results,
        count: results.length,
      }
    }),

  getById: publicProcedure
    .input(
      z.object({
        telegramId: z.number(),
      })
    )
    .query(async ({ input }) => {
      return await DB.select()
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(t.telegramId, input.telegramId))
    }),

  create: publicProcedure
    .input(
      z.array(
        z.object({
          title: z.string(),
          telegramId: z.number(),
          tag: z.string().optional(),
          link: z.url({ hostname: /^t\.me$/ }),
        })
      )
    )
    .output(z.array(z.number()))
    .mutation(async ({ input }) => {
      const rows = await DB.insert(GROUPS)
        .values(input)
        .onConflictDoUpdate({
          target: GROUPS.telegramId,
          set: {
            // this means: use the new value
            title: sql.raw(`excluded.${GROUPS.title.name}`),
            tag: sql.raw(`excluded.${GROUPS.tag.name}`),
            link: sql.raw(`excluded.${GROUPS.link.name}`),
          },
        })
        .returning()
      return rows.map((r) => r.telegramId)
    }),

  delete: publicProcedure
    .input(
      z.object({
        telegramId: z.number(),
      })
    )
    .output(z.boolean())
    .mutation(async ({ input }) => {
      const rows = await DB.delete(GROUPS).where(eq(GROUPS.telegramId, input.telegramId)).returning()
      return rows.length === 1
    }),
})
