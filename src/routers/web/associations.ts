import { asc, eq } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const ASSOCIATIONS = SCHEMA.WEB.associations

export default createTRPCRouter({
  getAllAssociations: publicProcedure
    .output(
      z.array(
        z.object({
          id: z.number(),
          name: z.string(),
          descriptionIt: z.string(),
          descriptionEn: z.string(),
          logoSvg: z.string().nullable(),
        })
      )
    )
    .query(async () => {
      const associations = await DB.select().from(ASSOCIATIONS).orderBy(asc(ASSOCIATIONS.id))

      const result = associations.map((c) => ({
        id: c.id,
        name: c.name,
        descriptionIt: c.descriptionIt,
        descriptionEn: c.descriptionEn,
        logoSvg: c.logoSvg,
      }))

      return result
    }),

  addAssociation: publicProcedure
    .input(
      z.object({
        name: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
        logoSvg: z.string().nullable(),
        createdBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { name, descriptionIt, descriptionEn, logoSvg, createdBy } = input

      const [res] = await DB.insert(ASSOCIATIONS)
        .values({
          name,
          descriptionIt,
          descriptionEn,
          logoSvg,
          createdBy,
        })
        .returning()

      return res
    }),

  editAssociation: publicProcedure
    .input(
      z.object({
        id: z.number(),
        name: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
        logoSvg: z.string().nullable(),
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, name, descriptionIt, descriptionEn, logoSvg, modifiedBy } = input

      const [res] = await DB.update(ASSOCIATIONS)
        .set({
          name,
          descriptionIt,
          descriptionEn,
          logoSvg,
          modifiedBy,
        })
        .where(eq(ASSOCIATIONS.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  deleteAssociation: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(ASSOCIATIONS).where(eq(ASSOCIATIONS.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
