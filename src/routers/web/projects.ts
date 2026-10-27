import { asc, eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { projectsCategories } from "@/db/schema/web/projects"
import { authorOf, createdByColumns, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
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
  getAllProjects: policy(publicData)
    .output(z.array(projectSchema))
    .query(async () => {
      return await DB.select().from(PROJECTS).orderBy(asc(PROJECTS.order))
    }),

  addProject: policy(dashboard("web:content:write"), { tokenOnly: true })
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(projectFormSchema)
    )
    .mutation(async ({ input, ctx }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category } = input

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
          ...createdByColumns(authorOf(ctx.actor)),
        })
        .returning()

      ctx.audit.set({ target: { type: "web.project", id: res.id, label: res.title }, after: res })
      return res
    }),

  editProject: policy(dashboard("web:content:write"), { tokenOnly: true })
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          projectFormSchema.extend({
            id: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category } = input
      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : undefined

      const [before] = await DB.select().from(PROJECTS).where(eq(PROJECTS.id, input.id)).limit(1)
      const [res] = await DB.update(PROJECTS)
        .set({
          title,
          descriptionIt,
          descriptionEn,
          ...(uploadedLogo ? { logo: uploadedLogo.url } : {}),
          link,
          category,
          ...modifiedByColumns(authorOf(ctx.actor)),
        })
        .where(eq(PROJECTS.id, input.id))
        .returning()

      ctx.audit.set({
        target: { type: "web.project", id: input.id, label: res?.title ?? before?.title },
        before,
        after: res,
      })
      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  reorderProjects: policy(dashboard("web:content:write"))
    .input(
      z.object({
        projectIds: z
          .array(z.number().int())
          .min(1)
          .refine((projectIds) => new Set(projectIds).size === projectIds.length),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const order = () =>
        DB.select({ id: PROJECTS.id, title: PROJECTS.title }).from(PROJECTS).orderBy(asc(PROJECTS.order))
      const before = await order()
      await DB.transaction(async (tx) => {
        await Promise.all(
          input.projectIds.map((id, index) => tx.update(PROJECTS).set({ order: index }).where(eq(PROJECTS.id, id)))
        )
      })

      ctx.audit.set({
        target: { type: "web.projects", id: "order", label: "Projects order" },
        before,
        after: await order(),
      })
      return { error: null }
    }),

  deleteProject: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id } = input
      const deleted = await DB.delete(PROJECTS).where(eq(PROJECTS.id, id)).returning()
      ctx.audit.set({ target: { type: "web.project", id, label: deleted[0]?.title }, before: deleted[0] })

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
