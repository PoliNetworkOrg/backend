import { and, eq, inArray, sql } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA, VIEWS } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const REPORTS = SCHEMA.WEB.groupLinkReports
const GROUPS = VIEWS.GROUPS.groupsView
const TG_GROUPS = SCHEMA.TG.groups
const WA_GROUPS = SCHEMA.WA.waGroups

const groupType = z.enum(["tg", "wa"])
const reportStatus = z.enum(["pending", "resolved", "dismissed"])

async function assertGroupExists(groupId: number, type: "tg" | "wa") {
  const groups =
    type === "tg"
      ? await DB.select({ id: TG_GROUPS.telegramId }).from(TG_GROUPS).where(eq(TG_GROUPS.telegramId, groupId)).limit(1)
      : await DB.select({ id: WA_GROUPS.id }).from(WA_GROUPS).where(eq(WA_GROUPS.id, groupId)).limit(1)
  if (!groups.length) throw new Error("Group not found")
}

export const reports = createTRPCRouter({
  create: publicProcedure
    .input(
      z.discriminatedUnion("reportType", [
        z.object({
          groupId: z.number().int(),
          type: groupType,
          reportType: z.literal("broken_link"),
          reportedLink: z.url(),
        }),
        z.object({
          reportType: z.literal("missing"),
          label: z.string().trim().min(1).max(256),
          details: z.string().trim().min(1).max(500),
        }),
      ])
    )
    .mutation(async ({ input }) => {
      if (input.reportType === "broken_link") {
        await assertGroupExists(input.groupId, input.type)
      }

      await DB.insert(REPORTS).values(input)

      return { ok: true as const }
    }),

  list: publicProcedure
    .input(
      z.object({
        statuses: z.array(reportStatus).min(1).default(["pending"]),
      })
    )
    .query(async ({ input }) => {
      return await DB.select({
        id: REPORTS.id,
        groupId: REPORTS.groupId,
        type: REPORTS.type,
        reportType: REPORTS.reportType,
        reportedLink: REPORTS.reportedLink,
        label: REPORTS.label,
        details: REPORTS.details,
        status: REPORTS.status,
        groupTitle: GROUPS.title,
        createdAt: REPORTS.createdAt,
      })
        .from(REPORTS)
        .leftJoin(GROUPS, and(eq(GROUPS.id, REPORTS.groupId), sql`${GROUPS}.type = ${REPORTS.type}`))
        .where(inArray(REPORTS.status, input.statuses))
        .orderBy(REPORTS.createdAt)
    }),

  resolve: publicProcedure.input(z.object({ ids: z.array(z.number().int()).min(1) })).mutation(async ({ input }) => {
    return await DB.update(REPORTS).set({ status: "resolved" }).where(inArray(REPORTS.id, input.ids)).returning()
  }),

  dismiss: publicProcedure.input(z.object({ ids: z.array(z.number().int()).min(1) })).mutation(async ({ input }) => {
    return await DB.update(REPORTS).set({ status: "dismissed" }).where(inArray(REPORTS.id, input.ids)).returning()
  }),
})
