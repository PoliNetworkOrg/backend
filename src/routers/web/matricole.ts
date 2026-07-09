import { desc, eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

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
  getAllGuides: publicProcedure.output(z.array(guideSchema)).query(async () => {
    return await DB.select().from(GUIDES_MATRICOLE).orderBy(desc(GUIDES_MATRICOLE.date))
  }),

  getLatestGuide: publicProcedure.output(guideSchema.nullable()).query(async () => {
    const [latestGuide] = await DB.select().from(GUIDES_MATRICOLE).orderBy(desc(GUIDES_MATRICOLE.date)).limit(1)

    return latestGuide || null
  }),

  addGuide: publicProcedure
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          guideFormSchema.extend({
            file: guideFileSchema,
            createdBy: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input }) => {
      const { version, date, file, createdBy } = input

      const uploadedFile = await uploadBlob(Buffer.from(await file.arrayBuffer()), "pdf", file.type)

      const [res] = await DB.insert(GUIDES_MATRICOLE)
        .values({
          version,
          date,
          file: uploadedFile.url,
          createdBy,
        })
        .returning()

      return res
    }),

  editGuide: publicProcedure
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          guideFormSchema.extend({
            id: z.coerce.number<string>(),
            file: guideFileSchema.optional(),
            modifiedBy: z.coerce.number<string>(),
          })
        )
    )
    .mutation(async ({ input }) => {
      const { id, version, date, file, modifiedBy } = input

      const uploadedFile = file
        ? await uploadBlob(Buffer.from(await file.arrayBuffer()), "pdf", file.type)
        : undefined

      const [res] = await DB.update(GUIDES_MATRICOLE)
        .set({
          version,
          date,
          ...(uploadedFile ? { file: uploadedFile.url } : {}),
          modifiedBy,
        })
        .where(eq(GUIDES_MATRICOLE.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  deleteGuide: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(GUIDES_MATRICOLE).where(eq(GUIDES_MATRICOLE.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
