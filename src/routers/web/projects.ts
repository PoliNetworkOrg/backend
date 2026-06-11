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
  order: z.number(),
})

export default createTRPCRouter({
  getAllProjects: publicProcedure.output(z.array(projectSchema)).query(async () => {
    return await DB.select().from(PROJECTS).orderBy(asc(PROJECTS.order))
  }),

  addProject: publicProcedure
    .input(projectSchema.omit({ id: true }).extend({ createdBy: z.number() }))
    .mutation(async ({ input }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category, createdBy, order } = input

      const [res] = await DB.insert(PROJECTS)
        .values({
          title,
          descriptionIt,
          descriptionEn,
          logo,
          link,
          category,
          createdBy,
          order,
        })
        .returning()

      return res
    }),

  editProject: publicProcedure.input(projectSchema.extend({ modifiedBy: z.number() })).mutation(async ({ input }) => {
    const { id, title, descriptionIt, descriptionEn, logo, link, category, modifiedBy, order } = input

    const [res] = await DB.update(PROJECTS)
      .set({
        title,
        descriptionIt,
        descriptionEn,
        logo,
        link,
        category,
        order,
        modifiedBy,
      })
      .where(eq(PROJECTS.id, id))
      .returning()

    if (!res) return { error: "NOT_FOUND" }
    return res
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
