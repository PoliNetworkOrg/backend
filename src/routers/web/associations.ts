import { asc, eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"
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
  getAllAssociations: publicProcedure.output(z.array(associationSchema)).query(async () => {
    const associations = await DB.select().from(ASSOCIATIONS).orderBy(asc(ASSOCIATIONS.id))

    return associations.map(formatAssociation)
  }),

  addAssociation: publicProcedure
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          associationFormSchema.extend({
            createdBy: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input }) => {
      const { name, descriptionIt, descriptionEn, logo, createdBy } = input

      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : null

      const [res] = await DB.insert(ASSOCIATIONS)
        .values({
          name,
          descriptionIt,
          descriptionEn,
          logo: uploadedLogo?.url ?? null,
          createdBy,
        })
        .returning()

      return formatAssociation(res)
    }),

  editAssociation: publicProcedure
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          associationFormSchema.extend({
            id: z.coerce.number<string>(),
            modifiedBy: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input }) => {
      const { id, name, descriptionIt, descriptionEn, logo, modifiedBy } = input

      const uploadedLogo = logo
        ? await uploadBlob(Buffer.from(await logo.arrayBuffer()), getImageExtension(logo), logo.type)
        : null

      const [res] = await DB.update(ASSOCIATIONS)
        .set({
          name,
          descriptionIt,
          descriptionEn,
          logo: uploadedLogo?.url ?? null,
          modifiedBy,
        })
        .where(eq(ASSOCIATIONS.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return formatAssociation(res)
    }),

  editAssociationLinks: publicProcedure
    .input(
      z.object({
        id: z.number(),
        links: associationLinksSchema,
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, links, modifiedBy } = input
      const { email, website, facebook, instagram, tiktok, x, youtube, telegram, linkedin, spotify } = links

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
          modifiedBy,
        })
        .where(eq(ASSOCIATIONS.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return formatAssociation(res)
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
