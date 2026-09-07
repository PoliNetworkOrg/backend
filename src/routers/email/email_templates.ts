import { asc, eq } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const EMAIL_TEMPLATES = SCHEMA.EMAIL.emailTemplateSchema

export default createTRPCRouter({
  getAll: publicProcedure
    .output(
      z.array(
        z.object({
          id: z.number(),
          subject: z.string(),
          body: z.string(),
        })
      )
    )
    .query(async () => {
      const results = await DB.select().from(EMAIL_TEMPLATES).orderBy(asc(EMAIL_TEMPLATES.id))

      return results
    }),

  add: publicProcedure
    .input(
      z.object({
        subject: z.string().min(1),
        body: z.string().min(1),
        createdBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { subject, body, createdBy } = input

      const [res] = await DB.insert(EMAIL_TEMPLATES)
        .values({
          subject,
          body,
          createdBy,
        })
        .returning()

      return res
    }),
  edit: publicProcedure
    .input(
      z.object({
        id: z.number(),
        subject: z.string().min(1),
        body: z.string().min(1),
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, subject, body, modifiedBy } = input

      const [res] = await DB.update(EMAIL_TEMPLATES)
        .set({
          subject,
          body,
          modifiedBy,
        })
        .where(eq(EMAIL_TEMPLATES.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),
  delete: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(EMAIL_TEMPLATES).where(eq(EMAIL_TEMPLATES.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
