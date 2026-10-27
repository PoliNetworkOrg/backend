import { and, eq, exists, ilike, inArray, ne, not, notExists, or, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { describeActor } from "@/idp/actor-info"
import { botReadOrDashboard, dashboard, SCOPE, seesHiddenGroups } from "@/idp/policies"
import { logger } from "@/logger"
import { WSS } from "@/server"
import { createTRPCRouter, policy } from "@/trpc"
import { lower } from "@/utils/db"

const GROUPS = SCHEMA.TG.groups
const LABELS = SCHEMA.COMMON.groupLabels
const LABEL_RELATIONS = SCHEMA.TG.tgGroupLabelRelations

export default createTRPCRouter({
  // TODO: this is performance HEAVY, make it more safe eventually
  // At the moment, this query is used by banall flowProducer in the telegram bot.
  // We may consider moving the flowProducer and ensure connection through the same Redis
  // instance or some other way of bridging the two parts together.
  getAll: policy(botReadOrDashboard("admin:access")).query(async () => {
    const beforeMs = performance.now()
    const results = await DB.select().from(GROUPS)
    const afterMs = performance.now()

    logger.warn({ queryMs: afterMs - beforeMs }, "Call to trpc.tg.groups.getAll, performance monitoring...")
    return results
  }),

  search: policy({ service: { scope: [SCOPE.tgRead, SCOPE.publicRead] }, ...dashboard("admin:access") })
    .input(
      z.object({
        query: z.string().min(1).max(100).optional(),
        limit: z.number().min(1).max(20).default(6),
        requiredLabels: z.array(z.string()).optional(),
        excludedLabels: z.array(z.string()).optional(),
        showHidden: z.boolean().default(false),
      })
    )
    .query(async ({ input, ctx }) => {
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

      const showHidden = input.showHidden && seesHiddenGroups(ctx.actor)
      if (showHidden === false) {
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

  getById: policy(botReadOrDashboard("admin:access"))
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

  getByInviteLink: policy(botReadOrDashboard("admin:access"))
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

  getByTag: policy(botReadOrDashboard("admin:access"))
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

  create: policy({ service: { scope: SCOPE.tgGroupsSync } })
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
    .mutation(async ({ input, ctx }) => {
      const replaced = []
      for (const group of input) {
        replaced.push(
          ...(await DB.delete(GROUPS)
            .where(and(eq(GROUPS.link, group.link), ne(GROUPS.telegramId, group.telegramId)))
            .returning())
        )
      }
      const before = await DB.select()
        .from(GROUPS)
        .where(
          inArray(
            GROUPS.telegramId,
            input.map((group) => group.telegramId)
          )
        )

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
      // The bot syncs groups often; only what it changes is recorded.
      const known = new Map(before.map((group) => [group.telegramId, group]))
      const changed = rows.filter((row) => {
        const old = known.get(row.telegramId)
        return !old || old.title !== row.title || old.tag !== row.tag || old.link !== row.link
      })
      if (replaced.length === 0 && changed.length === 0) ctx.audit.skip()
      ctx.audit.set({
        target:
          input.length === 1
            ? { type: "tg.group", id: input[0].telegramId, label: input[0].title }
            : {
                type: "tg.group",
                id: input.map((group) => group.telegramId).join(","),
                label: `${input.length} groups`,
              },
        before: [...replaced, ...changed.flatMap((row) => known.get(row.telegramId) ?? [])],
        after: changed,
      })
      return rows.map((r) => r.telegramId)
    }),

  delete: policy({ service: { scope: SCOPE.tgGroupsSync } })
    .input(
      z.object({
        telegramId: z.number(),
      })
    )
    .output(z.boolean())
    .mutation(async ({ input, ctx }) => {
      const rows = await DB.delete(GROUPS).where(eq(GROUPS.telegramId, input.telegramId)).returning()
      ctx.audit.set({ target: { type: "tg.group", id: input.telegramId, label: rows[0]?.title }, before: rows[0] })
      return rows.length === 1
    }),

  setHide: policy(dashboard("tg:groups:manage"))
    .input(
      z.object({
        telegramId: z.number(),
        hide: z.boolean(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const [before] = await DB.select({ hide: GROUPS.hide })
        .from(GROUPS)
        .where(eq(GROUPS.telegramId, input.telegramId))
        .limit(1)
      const rows = await DB.update(GROUPS)
        .set({ hide: input.hide })
        .where(eq(GROUPS.telegramId, input.telegramId))
        .returning()
      ctx.audit.set({
        target: { type: "tg.group", id: input.telegramId, label: rows[0]?.title },
        before,
        after: rows[0] && { hide: rows[0].hide },
      })

      return rows.length === 1
    }),

  /** The performer is the token's user. */
  leaveChat: policy(dashboard("tg:groups:manage"), { tokenOnly: true })
    .input(
      z.object({
        chatId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const performer = await describeActor(ctx.actor)
      const [group] = await DB.select().from(GROUPS).where(eq(GROUPS.telegramId, input.chatId)).limit(1)
      ctx.audit.set({ target: { type: "tg.group", id: input.chatId, label: group?.title }, before: group })
      const left = await WSS.leaveChat({
        chatId: input.chatId,
        performerId: performer.telegramId ? Number(performer.telegramId) : null,
        performer,
      })
      if (!left) return { error: "BOT_ERROR" }

      const rows = await DB.delete(GROUPS).where(eq(GROUPS.telegramId, input.chatId)).returning()
      if (rows.length === 0) return { error: "NOT_FOUND" }

      return { error: null }
    }),
})
