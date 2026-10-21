import { and, eq, inArray, sql } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA, VIEWS } from "@/db"
import { dashboard, SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

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

function reportsTarget(ids: number[]) {
  return { type: "web.report", id: ids.join(","), label: ids.length === 1 ? null : `${ids.length} reports` }
}

export const reports = createTRPCRouter({
  create: policy({ service: { scope: SCOPE.publicRead } })
    .input(
      z.discriminatedUnion("reportType", [
        z.object({
          groupId: z.number().int(),
          type: groupType,
          reportType: z.literal("broken_link"),
          reportedLink: z.url().max(256),
        }),
        z.object({
          reportType: z.literal("missing"),
          label: z.string().trim().min(1).max(256),
          details: z.string().trim().min(1).max(500),
        }),
      ])
    )
    .mutation(async ({ input, ctx }) => {
      if (input.reportType === "broken_link") {
        await assertGroupExists(input.groupId, input.type)
      }

      const [report] = await DB.insert(REPORTS).values(input).returning()
      ctx.audit.set({
        target: { type: "web.report", id: report.id, label: report.label ?? report.reportedLink },
        after: report,
      })

      return { ok: true as const }
    }),

  list: policy(dashboard("web:reports:manage"))
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

  resolve: policy(dashboard("web:reports:manage"))
    .input(z.object({ ids: z.array(z.number().int()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const before = await DB.select().from(REPORTS).where(inArray(REPORTS.id, input.ids))
      const after = await DB.update(REPORTS)
        .set({ status: "resolved" })
        .where(inArray(REPORTS.id, input.ids))
        .returning()
      ctx.audit.set({ target: reportsTarget(input.ids), before, after })
      return after
    }),

  dismiss: policy(dashboard("web:reports:manage"))
    .input(z.object({ ids: z.array(z.number().int()).min(1) }))
    .mutation(async ({ input, ctx }) => {
      const before = await DB.select().from(REPORTS).where(inArray(REPORTS.id, input.ids))
      const after = await DB.update(REPORTS)
        .set({ status: "dismissed" })
        .where(inArray(REPORTS.id, input.ids))
        .returning()
      ctx.audit.set({ target: reportsTarget(input.ids), before, after })
      return after
    }),
})
