import { and, asc, eq, exists, ilike, not, notExists, or, type SQL, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA, VIEWS } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const GROUPS = VIEWS.GROUPS.groupsView
const LABELS = SCHEMA.COMMON.groupLabels
const LABEL_RELATIONS = VIEWS.GROUPS.labelsRelationsView

export const search = createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const results = await DB.select({
      id: GROUPS.id,
      title: GROUPS.title,
      type: GROUPS.type,
      link: GROUPS.link,
      hide: GROUPS.hide,
      labels: sql<
        string[]
      >`coalesce(array_agg(${LABELS.label}) filter (where ${LABELS.label} is not null) using array_agg, '{}')`,
    })
      .from(GROUPS)
      .leftJoin(LABEL_RELATIONS, eq(LABEL_RELATIONS.groupId, GROUPS.id))
      .leftJoin(LABELS, eq(LABEL_RELATIONS.labelId, LABELS.id))
      .groupBy(GROUPS.id)

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
                  eq(LABEL_RELATIONS.groupId, GROUPS.id),
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
                  eq(LABEL_RELATIONS.groupId, GROUPS.id),
                  or(...excludedLabels.map((label) => eq(LABELS.label, label)))
                )
              )
          )
        )
      }

      if (query && query.length > 0) {
        const likeQuery = query.split(" ").join("%")
        const queryWhere = or(ilike(GROUPS.title, `%${likeQuery}%`))
        if (queryWhere) conditions.push(queryWhere) // or(...) returns undefined? idk
      }

      if (input.showHidden === false) {
        conditions.push(not(GROUPS.hide))
      }

      const results = await DB.select({
        telegramId: GROUPS.id,
        title: GROUPS.title,
        type: GROUPS.type,
        link: GROUPS.link,
        hide: GROUPS.hide,
        labels: sql<
          string[]
        >`coalesce(array_agg(${LABELS.label}) filter (where ${LABELS.label} is not null) using array_agg, '{}')`,
      })
        .from(GROUPS)
        .leftJoin(LABEL_RELATIONS, eq(LABEL_RELATIONS.groupId, GROUPS.id))
        .leftJoin(LABELS, eq(LABEL_RELATIONS.labelId, LABELS.id))
        .where(and(...conditions))
        .groupBy(GROUPS.id)
        .orderBy((t) => asc(t.type))
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
        .where((t) => eq(t.id, input.telegramId))

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
})
