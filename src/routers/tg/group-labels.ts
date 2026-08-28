import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const GROUP_LABELS = SCHEMA.TG.groupLabels
const GROUP_LABEL_RELATIONS = SCHEMA.TG.groupLabelRelations

export const groupLabel = z.string().min(1).max(128)
const label = groupLabel
// type GroupLabel = z.infer<typeof groupLabel>

export default createTRPCRouter({
  getAll: publicProcedure.query(async () => {
    const results = await DB.select().from(GROUP_LABELS)

    return results
  }),

  getAllRelations: publicProcedure.query(async () => {
    const results = await DB.select().from(GROUP_LABEL_RELATIONS)

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

      const result = await DB.delete(GROUP_LABELS).where(eq(GROUP_LABELS.label, label)).returning()
      return result
    }),

  modify: publicProcedure
    .input(
      z.object({
        label,
        description: z.string().optional(),
        color: z
          .string()
          .regex(/^#[0-9A-Fa-f]{6}$/)
          .optional(),
        updatedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { label, description, color, updatedBy } = input

      const result = await DB.update(GROUP_LABELS)
        .set({
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

      const result = await DB.insert(GROUP_LABEL_RELATIONS)
        .values({
          groupId,
          label,
        })
        .returning()
      return result
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

      const result = await DB.delete(GROUP_LABEL_RELATIONS)
        .where(and(eq(GROUP_LABEL_RELATIONS.groupId, groupId), eq(GROUP_LABEL_RELATIONS.label, label)))
        .returning()
      return result
    }),
})
