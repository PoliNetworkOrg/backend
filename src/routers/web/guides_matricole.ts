import { desc, eq } from "drizzle-orm"
import z from "zod"
import { deleteBlob, uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { authorOf, createdByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const GUIDES_MATRICOLE = SCHEMA.WEB.guidesMatricole

const guideFileSchema = z
  .file()
  .mime(["application/pdf"])
  .min(1)
  .max(10 * 1024 * 1024)

const guideFormSchema = z.object({
  version: z.string(),
  date: z.string(),
})

const guideSchema = z.object({
  id: z.number(),
  version: z.string(),
  date: z.string(),
  file: z.string(),
})

export default createTRPCRouter({
  getAllGuides: policy(publicData)
    .output(z.array(guideSchema))
    .query(async () => {
      return await DB.select().from(GUIDES_MATRICOLE).orderBy(desc(GUIDES_MATRICOLE.date))
    }),

  getLatestGuide: policy(publicData)
    .output(guideSchema.nullable())
    .query(async () => {
      const res = await DB.select().from(GUIDES_MATRICOLE).orderBy(desc(GUIDES_MATRICOLE.date)).limit(1)

      return res[0] || null
    }),

  addGuide: policy(dashboard("web:content:write"))
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          guideFormSchema.extend({
            file: guideFileSchema,
            createdBy: z.coerce.number<string>().optional(),
          })
        )
    )
    .mutation(async ({ input, ctx }) => {
      const { version, date, file, createdBy } = input

      const [existing] = await DB.select({ id: GUIDES_MATRICOLE.id })
        .from(GUIDES_MATRICOLE)
        .where(eq(GUIDES_MATRICOLE.version, version))
      if (existing) return { error: "DUPLICATE_VERSION" }

      const uploadedFile = await uploadBlob(Buffer.from(await file.arrayBuffer()), "pdf", file.type)

      const [res] = await DB.insert(GUIDES_MATRICOLE)
        .values({
          version,
          date,
          file: uploadedFile.url,
          ...createdByColumns(authorOf(ctx.actor, createdBy)),
        })
        .returning()

      return res
    }),

  deleteGuide: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(GUIDES_MATRICOLE).where(eq(GUIDES_MATRICOLE.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }

      await deleteBlob(deleted[0].file)
      return { error: null }
    }),
})
