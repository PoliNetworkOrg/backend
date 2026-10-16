import { and, asc, eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { projectResourceKinds, projectsCategories } from "@/db/schema/web/projects"
import { authorOf, createdByColumns, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import { getImageExtension } from "@/utils/web"

const PROJECTS = SCHEMA.WEB.projects
const PROJECT_RESOURCES = SCHEMA.WEB.projectResources

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

const resourceUrlSchema = z.url({ protocol: /^https?$/ })

const projectResourceSchema = z.object({
  id: z.number(),
  kind: z.enum(projectResourceKinds),
  url: z.string(),
})

export default createTRPCRouter({
  getProject: policy(publicData)
    .input(z.object({ id: z.number().int() }))
    .output(projectSchema.extend({ resources: z.array(projectResourceSchema) }).nullable())
    .query(async ({ input }) => {
      const [project] = await DB.select().from(PROJECTS).where(eq(PROJECTS.id, input.id))
      if (!project) return null

      const resources = await DB.select()
        .from(PROJECT_RESOURCES)
        .where(eq(PROJECT_RESOURCES.projectId, project.id))
        .orderBy(asc(PROJECT_RESOURCES.order), asc(PROJECT_RESOURCES.id))

      return { ...project, resources }
    }),

  getAllProjects: policy(publicData)
    .output(z.array(projectSchema))
    .query(async () => {
      return await DB.select().from(PROJECTS).orderBy(asc(PROJECTS.order))
    }),

  addProject: policy(dashboard("web:content:write"))
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          projectFormSchema.extend({
            createdBy: z.coerce.number<string>().optional(),
          })
        )
    )
    .mutation(async ({ input, ctx }) => {
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
          ...createdByColumns(authorOf(ctx.actor, createdBy)),
        })
        .returning()

      return res
    }),

  editProject: policy(dashboard("web:content:write"))
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          projectFormSchema.extend({
            id: z.coerce.number<string>(),
            modifiedBy: z.coerce.number<string>().optional(),
          })
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { title, descriptionIt, descriptionEn, logo, link, category, modifiedBy } = input
      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : undefined

      const [res] = await DB.update(PROJECTS)
        .set({
          title,
          descriptionIt,
          descriptionEn,
          ...(uploadedLogo ? { logo: uploadedLogo.url } : {}),
          link,
          category,
          ...modifiedByColumns(authorOf(ctx.actor, modifiedBy)),
        })
        .where(eq(PROJECTS.id, input.id))
        .returning()

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
    .mutation(async ({ input }) => {
      await DB.transaction(async (tx) => {
        await Promise.all(
          input.projectIds.map((id, index) => tx.update(PROJECTS).set({ order: index }).where(eq(PROJECTS.id, id)))
        )
      })

      return { error: null }
    }),

  deleteProject: policy(dashboard("web:content:write"))
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

  addProjectResource: policy(dashboard("web:content:write"))
    .input(
      z.object({
        projectId: z.number().int(),
        kind: z.enum(projectResourceKinds),
        url: resourceUrlSchema,
        createdBy: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { projectId, kind, url, createdBy } = input

      const [project] = await DB.select({ id: PROJECTS.id }).from(PROJECTS).where(eq(PROJECTS.id, projectId))
      if (!project) return { error: "NOT_FOUND" }

      const existing = await DB.select({ id: PROJECT_RESOURCES.id })
        .from(PROJECT_RESOURCES)
        .where(eq(PROJECT_RESOURCES.projectId, projectId))

      const [res] = await DB.insert(PROJECT_RESOURCES)
        .values({
          projectId,
          kind,
          url,
          order: existing.length,
          ...createdByColumns(authorOf(ctx.actor, createdBy)),
        })
        .returning()

      return res
    }),

  editProjectResource: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number().int(),
        kind: z.enum(projectResourceKinds),
        url: resourceUrlSchema,
        modifiedBy: z.number().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, kind, url, modifiedBy } = input

      const [res] = await DB.update(PROJECT_RESOURCES)
        .set({ kind, url, ...modifiedByColumns(authorOf(ctx.actor, modifiedBy)) })
        .where(eq(PROJECT_RESOURCES.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  reorderProjectResources: policy(dashboard("web:content:write"))
    .input(
      z.object({
        projectId: z.number().int(),
        resourceIds: z
          .array(z.number().int())
          .min(1)
          .refine((resourceIds) => new Set(resourceIds).size === resourceIds.length),
      })
    )
    .mutation(async ({ input }) => {
      await DB.transaction(async (tx) => {
        await Promise.all(
          input.resourceIds.map((id, index) =>
            tx
              .update(PROJECT_RESOURCES)
              .set({ order: index })
              .where(and(eq(PROJECT_RESOURCES.id, id), eq(PROJECT_RESOURCES.projectId, input.projectId)))
          )
        )
      })

      return { error: null }
    }),

  deleteProjectResource: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number().int(),
      })
    )
    .mutation(async ({ input }) => {
      const deleted = await DB.delete(PROJECT_RESOURCES).where(eq(PROJECT_RESOURCES.id, input.id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
