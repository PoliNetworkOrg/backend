import { asc, eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { projectsCategories } from "@/db/schema/web/projects"
import { createTRPCRouter, publicProcedure } from "@/trpc"
import { getImageExtension } from "@/utils/web"

const PROJECTS = SCHEMA.WEB.projects

const logoFileSchema = z
  .file()
  .mime(["image/png", "image/jpeg", "image/svg+xml"])
  .min(1)
  .max(1024 * 1024)

const projectFormSchema = z.object({
  title: z.string(),
  descriptionIt: z.string(),
  descriptionEn: z.string(),
  logo: logoFileSchema.optional(),
  link: z.string().transform((value) => value || null),
  category: z.enum(projectsCategories),
})

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
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          projectFormSchema.extend({
            createdBy: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category, createdBy } = input

      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : null

      const [res] = await DB.insert(PROJECTS)
        .values({
          title,
          descriptionIt,
          descriptionEn,
          logo: uploadedLogo?.url ?? null,
          link,
          category,
          createdBy,
        })
        .returning()

      return res
    }),

  editProject: publicProcedure
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          projectFormSchema.extend({
            id: z.coerce.number<string>(),
            modifiedBy: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category, modifiedBy } = input
      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : null

      const [res] = await DB.update(PROJECTS)
        .set({
          title,
          descriptionIt,
          descriptionEn,
          ...(uploadedLogo && { logo: uploadedLogo.url }),
          link,
          category,
          modifiedBy,
        })
        .where(eq(PROJECTS.id, input.id))
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
