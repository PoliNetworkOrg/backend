import { asc, eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { authorOf, createdByColumns, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import { getImageExtension } from "@/utils/web"

const ASSOCIATIONS = SCHEMA.WEB.associations

const logoFileSchema = z
  .file()
  .mime(["image/png", "image/jpeg", "image/svg+xml"])
  .min(1)
  .max(1024 * 1024)

const associationLinksSchema = z.object({
  email: z.email().nullable(),
  website: z.url().nullable(),
  facebook: z.url().nullable(),
  instagram: z.url().nullable(),
  tiktok: z.url().nullable(),
  x: z.url().nullable(),
  youtube: z.url().nullable(),
  telegram: z.url().nullable(),
  linkedin: z.url().nullable(),
  spotify: z.url().nullable(),
})

const associationFormSchema = z.object({
  name: z.string(),
  descriptionIt: z.string(),
  descriptionEn: z.string(),
  logo: logoFileSchema.optional(),
})

const associationSchema = z.object({
  id: z.number(),
  name: z.string(),
  descriptionIt: z.string(),
  descriptionEn: z.string(),
  logo: z.string().nullable(),
  links: associationLinksSchema,
})

function formatAssociation(association: typeof ASSOCIATIONS.$inferSelect): z.infer<typeof associationSchema> {
  return {
    id: association.id,
    name: association.name,
    descriptionIt: association.descriptionIt,
    descriptionEn: association.descriptionEn,
    logo: association.logo,
    links: {
      email: association.email,
      website: association.website,
      facebook: association.facebook,
      instagram: association.instagram,
      tiktok: association.tiktok,
      x: association.x,
      youtube: association.youtube,
      telegram: association.telegram,
      linkedin: association.linkedin,
      spotify: association.spotify,
    },
  }
}

export default createTRPCRouter({
  getAllAssociations: policy(publicData)
    .output(z.array(associationSchema))
    .query(async () => {
      const associations = await DB.select().from(ASSOCIATIONS).orderBy(asc(ASSOCIATIONS.id))

      return associations.map(formatAssociation)
    }),

  addAssociation: policy(dashboard("web:content:write"), { tokenOnly: true })
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(associationFormSchema)
    )
    .mutation(async ({ input, ctx }) => {
      const { name, descriptionIt, descriptionEn, logo } = input

      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : null

      const [res] = await DB.insert(ASSOCIATIONS)
        .values({
          name,
          descriptionIt,
          descriptionEn,
          logo: uploadedLogo?.url ?? null,
          ...createdByColumns(authorOf(ctx.actor)),
        })
        .returning()

      ctx.audit.set({ target: { type: "web.association", id: res.id, label: res.name }, after: res })
      return formatAssociation(res)
    }),

  editAssociation: policy(dashboard("web:content:write"), { tokenOnly: true })
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          associationFormSchema.extend({
            id: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { id, name, descriptionIt, descriptionEn, logo } = input

      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : undefined

      const [before] = await DB.select().from(ASSOCIATIONS).where(eq(ASSOCIATIONS.id, id)).limit(1)
      const [res] = await DB.update(ASSOCIATIONS)
        .set({
          name,
          descriptionIt,
          descriptionEn,
          ...(uploadedLogo ? { logo: uploadedLogo.url } : {}),
          ...modifiedByColumns(authorOf(ctx.actor)),
        })
        .where(eq(ASSOCIATIONS.id, id))
        .returning()

      ctx.audit.set({
        target: { type: "web.association", id, label: res?.name ?? before?.name },
        before,
        after: res,
      })
      if (!res) return { error: "NOT_FOUND" }
      return formatAssociation(res)
    }),

  editAssociationLinks: policy(dashboard("web:content:write"), { tokenOnly: true })
    .input(
      z.object({
        id: z.number(),
        links: associationLinksSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, links } = input
      const { email, website, facebook, instagram, tiktok, x, youtube, telegram, linkedin, spotify } = links

      const [before] = await DB.select().from(ASSOCIATIONS).where(eq(ASSOCIATIONS.id, id)).limit(1)
      const [res] = await DB.update(ASSOCIATIONS)
        .set({
          email,
          website,
          facebook,
          instagram,
          tiktok,
          x,
          youtube,
          telegram,
          linkedin,
          spotify,
          ...modifiedByColumns(authorOf(ctx.actor)),
        })
        .where(eq(ASSOCIATIONS.id, id))
        .returning()

      ctx.audit.set({
        target: { type: "web.association", id, label: res?.name ?? before?.name },
        before,
        after: res,
      })
      if (!res) return { error: "NOT_FOUND" }
      return formatAssociation(res)
    }),

  deleteAssociation: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id } = input
      const deleted = await DB.delete(ASSOCIATIONS).where(eq(ASSOCIATIONS.id, id)).returning()
      ctx.audit.set({ target: { type: "web.association", id, label: deleted[0]?.name }, before: deleted[0] })

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
