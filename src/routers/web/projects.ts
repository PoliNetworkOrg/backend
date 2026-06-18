import { asc, eq } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA } from "@/db"
import { projectsCategories } from "@/db/schema/web/projects"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const PROJECTS = SCHEMA.WEB.projects

const projectSchema = z.object({
  id: z.number(),
  title: z.string(),
  descriptionIt: z.string(),
  descriptionEn: z.string(),
  logo: z.string().nullable(),
  link: z.string().nullable(),
  category: z.enum(projectsCategories),
})

export default createTRPCRouter({
  getAllProjects: publicProcedure.output(z.array(projectSchema)).query(async () => {
    return await DB.select().from(PROJECTS).orderBy(asc(PROJECTS.order))
  }),

  addProject: publicProcedure
    .input(projectSchema.omit({ id: true }).extend({ createdBy: z.number() }))
    .mutation(async ({ input }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category, createdBy } = input

      const [res] = await DB.insert(PROJECTS)
        .values({
          title,
          descriptionIt,
          descriptionEn,
          logo,
          link,
          category,
          createdBy,
        })
        .returning()

      return res
    }),

  editProject: publicProcedure.input(projectSchema.extend({ modifiedBy: z.number() })).mutation(async ({ input }) => {
    const { id, title, descriptionIt, descriptionEn, logo, link, category, modifiedBy } = input

    const [res] = await DB.update(PROJECTS)
      .set({
        title,
        descriptionIt,
        descriptionEn,
        logo,
        link,
        category,
        modifiedBy,
      })
      .where(eq(PROJECTS.id, id))
      .returning()

    if (!res) return { error: "NOT_FOUND" }
    return res
  }),

  reorderProjects: publicProcedure
    .input(
      z.object({
        projectIds: z
          .array(z.number().int())
          .min(1)
          .refine((projectIds) => new Set(projectIds).size === projectIds.length),
      })
    )
    .mutation(async ({ input }) => {
      await DB.transaction(async (tx) => {
        await Promise.all(
          input.projectIds.map((id, index) => tx.update(PROJECTS).set({ order: index }).where(eq(PROJECTS.id, id)))
        )
      })

      return { error: null }
    }),

  deleteProject: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(PROJECTS).where(eq(PROJECTS.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
