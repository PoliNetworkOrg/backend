import { and, eq, exists, ilike, ne, not, notExists, or, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { WSS } from "@/server"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { lower } from "@/utils/db"

const GROUPS = SCHEMA.TG.groups
const LABELS = SCHEMA.COMMON.groupLabels
const LABEL_RELATIONS = SCHEMA.TG.tgGroupLabelRelations

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
        query: z.string().min(1).max(100).optional(),
        limit: z.number().min(1).max(20).default(6),
        requiredLabels: z.array(z.string()).optional(),
        excludedLabels: z.array(z.string()).optional(),
        showHidden: z.boolean().default(false),
      })
    )
    .query(async ({ input }) => {
      // TODO: implement some kind of recommender system to promote groups that are more relevant
      // raw string search is weird, we should boost more used groups

      const { query, limit, requiredLabels, excludedLabels } = input
      const conditions: SQL[] = []

      if (requiredLabels && requiredLabels.length > 0) {
        conditions.push(
          exists(
            DB.select()
              .from(LABEL_RELATIONS)
              .innerJoin(LABELS, eq(LABEL_RELATIONS.labelId, LABELS.id))
              .where(
                and(
                  eq(LABEL_RELATIONS.groupId, GROUPS.telegramId),
                  or(...requiredLabels.map((label) => eq(LABELS.label, label)))
                )
              )
          )
        )
      }

      if (excludedLabels && excludedLabels.length > 0) {
        conditions.push(
          notExists(
            DB.select()
              .from(LABEL_RELATIONS)
              .innerJoin(LABELS, eq(LABEL_RELATIONS.labelId, LABELS.id))
              .where(
                and(
                  eq(LABEL_RELATIONS.groupId, GROUPS.telegramId),
                  or(...excludedLabels.map((label) => eq(LABELS.label, label)))
                )
              )
          )
        )
      }

      if (query && query.length > 0) {
        const likeQuery = query.split(" ").join("%")
        const queryWhere = or(ilike(GROUPS.title, `%${likeQuery}%`), ilike(GROUPS.tag, `%${likeQuery}%`))
        if (queryWhere) conditions.push(queryWhere) // or(...) returns undefined? idk
      }

      if (input.showHidden === false) {
        conditions.push(not(GROUPS.hide))
      }

      const results = await DB.select({
        telegramId: GROUPS.telegramId,
        title: GROUPS.title,
        tag: GROUPS.tag,
        link: GROUPS.link,
        hide: GROUPS.hide,
      })
        .from(GROUPS)
        .where(and(...conditions))
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
      const res = await DB.select()
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(t.telegramId, input.telegramId))

      if (res.length === 0) return null
      return res[0]
    }),

  getByInviteLink: publicProcedure
    .input(
      z.object({
        inviteLink: z.url(),
      })
    )
    .query(async ({ input }) => {
      const res = await DB.select()
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(t.link, input.inviteLink))

      if (res.length === 0) return null
      return res[0]
    }),

  getByTag: publicProcedure
    .input(
      z.object({
        tag: z.string(),
      })
    )
    .query(async ({ input }) => {
      const res = await DB.select()
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(lower(t.tag), input.tag.toLowerCase().replace("@", "")))

      if (res.length === 0) return null
      return res[0]
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
      for (const group of input) {
        await DB.delete(GROUPS).where(and(eq(GROUPS.link, group.link), ne(GROUPS.telegramId, group.telegramId)))
      }

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

  setHide: publicProcedure
    .input(
      z.object({
        telegramId: z.number(),
        hide: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const rows = await DB.update(GROUPS)
        .set({ hide: input.hide })
        .where(eq(GROUPS.telegramId, input.telegramId))
        .returning()

      return rows.length === 1
    }),

  leaveChat: publicProcedure
    .input(
      z.object({
        chatId: z.number(),
        performerId: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const left = await WSS.leaveChat(input.chatId, input.performerId)
      if (!left) return { error: "BOT_ERROR" }

      const rows = await DB.delete(GROUPS).where(eq(GROUPS.telegramId, input.chatId)).returning()
      if (rows.length === 0) return { error: "NOT_FOUND" }

      return { error: null }
    }),
})
