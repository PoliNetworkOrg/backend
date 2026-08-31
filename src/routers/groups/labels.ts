import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA, VIEWS } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const GROUPS = VIEWS.GROUPS.groupsView
const GROUP_LABELS = SCHEMA.COMMON.groupLabels
const TG_RELATIONS = SCHEMA.TG.tgGroupLabelRelations
const WA_RELATIONS = SCHEMA.WA.waGroupLabelRelations

export const groupLabel = z.string().min(1).max(128)
const label = groupLabel
// type GroupLabel = z.infer<typeof groupLabel>

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const results = await DB.select().from(GROUP_LABELS)

    return results
  }),

  create: publicProcedure
    .input(
      z.object({
        label,
        description: z.string().optional(),
        color: z.string().regex(/^#[0-9A-Fa-f]{6}$/),
        createdBy: z.number(),
        updatedBy: z.number().optional(),
      })
    )
    .mutation(async ({ input }) => {
      const { label, description, color, createdBy } = input

      const result = await DB.insert(GROUP_LABELS)
        .values({
          label,
          description,
          color,
          createdBy,
        })
        .returning()

      return result
    }),

  delete: publicProcedure
    .input(
      z.object({
        label,
      })
    )
    .mutation(async ({ input }) => {
      const { label } = input

      const labelRow = await DB.select({ id: GROUP_LABELS.id })
        .from(GROUP_LABELS)
        .where(eq(GROUP_LABELS.label, label))
        .limit(1)
      if (!labelRow.length) return []
      const labelId = labelRow[0].id

      const [[tgCount], [waCount]] = await Promise.all([
        DB.select({ count: sql<string>`count(*)` }).from(TG_RELATIONS).where(eq(TG_RELATIONS.labelId, labelId)),
        DB.select({ count: sql<string>`count(*)` }).from(WA_RELATIONS).where(eq(WA_RELATIONS.labelId, labelId)),
      ])
      const groupCount = Number(tgCount?.count ?? 0) + Number(waCount?.count ?? 0)
      if (groupCount > 0) {
        throw new Error(
          `This label is still assigned to ${groupCount} group${groupCount === 1 ? "" : "s"}. Remove it from them before deleting.`
        )
      }

      const result = await DB.delete(GROUP_LABELS).where(eq(GROUP_LABELS.label, label)).returning()
      return result
    }),

  modify: publicProcedure
    .input(
      z.object({
        label,
        newLabel: label.optional(),
        description: z.string().optional(),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        updatedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { label, newLabel, description, color, updatedBy } = input

      const result = await DB.update(GROUP_LABELS)
        .set({
          label: newLabel,
          description,
          color,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(eq(GROUP_LABELS.label, label))
        .returning()

      return result
    }),

  tagGroup: publicProcedure
    .input(
      z.object({
        groupId: z.number(),
        label,
      })
    )
    .mutation(async ({ input }) => {
      const { groupId, label } = input

      const type = await DB.select({ type: GROUPS.type }).from(GROUPS).where(eq(GROUPS.id, groupId)).limit(1)
      if (!type.length) throw new Error("Group not found")
      const labelIdResult = await DB.select({ id: GROUP_LABELS.id })
        .from(GROUP_LABELS)
        .where(eq(GROUP_LABELS.label, label))
        .limit(1)
      if (!labelIdResult.length) throw new Error("Label not found")
      const labelId = labelIdResult[0].id

      if (type[0].type === "tg") {
        const result = await DB.insert(TG_RELATIONS)
          .values({
            groupId,
            labelId,
          })
          .returning()
        return result
      } else if (type[0].type === "wa") {
        const result = await DB.insert(WA_RELATIONS)
          .values({
            groupId,
            labelId,
          })
          .returning()
        return result
      }

      throw new Error("Invalid group type")
    }),

  untagGroup: publicProcedure
    .input(
      z.object({
        groupId: z.number(),
        label,
      })
    )
    .mutation(async ({ input }) => {
      const { groupId, label } = input

      const labelIdResult = await DB.select({ id: GROUP_LABELS.id })
        .from(GROUP_LABELS)
        .where(eq(GROUP_LABELS.label, label))
        .limit(1)
      if (!labelIdResult.length) throw new Error("Label not found")
      const labelId = labelIdResult[0].id

      const result = await Promise.allSettled([
        DB.delete(TG_RELATIONS)
          .where(and(eq(TG_RELATIONS.groupId, groupId), eq(TG_RELATIONS.labelId, labelId)))
          .returning(),
        await DB.delete(WA_RELATIONS)
          .where(and(eq(WA_RELATIONS.groupId, groupId), eq(WA_RELATIONS.labelId, labelId)))
          .returning(),
      ])

      return result.flatMap((r) => (r.status === "fulfilled" ? r.value : []))
    }),
})
