import { and, eq, ilike, ne, not, or, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { WSS } from "@/server"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { lower } from "@/utils/db"

const GROUPS = SCHEMA.TG.groups
const GROUPS_CACHE_TTL_MS = 30_000
let groupsCache: { expiresAt: number; value: (typeof GROUPS.$inferSelect)[] } | null = null
let groupsCachePromise: Promise<(typeof GROUPS.$inferSelect)[]> | null = null
let groupsCacheVersion = 0

const invalidateGroupsCache = () => {
  groupsCacheVersion += 1
  groupsCache = null
  groupsCachePromise = null
}

const getAllGroups = async () => {
  const now = Date.now()
  if (groupsCache && groupsCache.expiresAt > now) return groupsCache.value
  if (groupsCachePromise) return groupsCachePromise

  const version = groupsCacheVersion
  const promise = DB.select()
    .from(GROUPS)
    .then((value) => {
      if (version === groupsCacheVersion) groupsCache = { value, expiresAt: Date.now() + GROUPS_CACHE_TTL_MS }
      if (groupsCachePromise === promise) groupsCachePromise = null
      return value
    })
    .catch((error) => {
      if (groupsCachePromise === promise) groupsCachePromise = null
      throw error
    })

  groupsCachePromise = promise
  return groupsCachePromise
}

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const beforeMs = performance.now()
    const results = await getAllGroups()
    const afterMs = performance.now()

    logger.warn({ queryMs: afterMs - beforeMs }, "Call to trpc.tg.groups.getAll, performance monitoring...")
    return results
  }),

  search: publicProcedure
    .input(
      z.object({
        query: z.string().min(1).max(100),
        limit: z.number().min(1).max(20).default(6),
        showHidden: z.boolean().default(false),
      })
    )
    .query(async ({ input }) => {
      const { query, limit } = input

      const likeQuery = query.split(" ").join("%")
      const whereClause = or(ilike(GROUPS.title, `%${likeQuery}%`), ilike(GROUPS.tag, `%${likeQuery}%`))

      const results = await DB.select({
        telegramId: GROUPS.telegramId,
        title: GROUPS.title,
        tag: GROUPS.tag,
        link: GROUPS.link,
        hide: GROUPS.hide,
      })
        .from(GROUPS)
        .where(input.showHidden ? whereClause : and(whereClause, not(GROUPS.hide)))
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
      invalidateGroupsCache()
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
      invalidateGroupsCache()
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
      if (rows.length === 1) invalidateGroupsCache()
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

      if (rows.length === 1) invalidateGroupsCache()
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

      invalidateGroupsCache()
      return { error: null }
    }),
})
