import { eq } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const FAQS = SCHEMA.WEB.faqs

const FAQ_CATEGORIES = SCHEMA.WEB.faqCategories

export default createTRPCRouter({
  getAllFaqs: publicProcedure
    .output(
      z.array(
        z.object({
          title: z.string(),
          icon: z.string().nullable(),
          faqs: z.array(
            z.object({
              title: z.string(),
              description: z.string(),
            })
          ),
        })
      )
    )
    .query(async () => {
      const faqs = await DB.select().from(FAQS)
      const categories = await DB.select().from(FAQ_CATEGORIES)

      const result = categories.map((c) => ({
        title: c.title,
        icon: c.icon,
        faqs: faqs
          .filter((f) => f.categoryId === c.id)
          .map((f) => ({
            title: f.title,
            description: f.description,
          })),
      }))

      return result
    }),

  addFaqs: publicProcedure
    .input(
      z.object({
        title: z.string(),
        description: z.string(),
        categoryId: z.number(),
        createdBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { title, description, categoryId, createdBy } = input

      const [res] = await DB.insert(FAQS)
        .values({
          title,
          description,
          categoryId,
          createdBy,
        })
        .returning()

      return res
    }),

  addFaqsCategory: publicProcedure
    .input(
      z.object({
        title: z.string(),
        icon: z.string().nullable(),
        createdBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { title, icon, createdBy } = input

      const [res] = await DB.insert(FAQ_CATEGORIES)
        .values({
          title,
          icon,
          createdBy,
        })
        .returning()

      return res
    }),

  editFaqs: publicProcedure
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        description: z.string(),
        categoryId: z.number(),
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, title, description, categoryId, modifiedBy } = input

      const [res] = await DB.update(FAQS)
        .set({
          title,
          description,
          categoryId,
          modifiedBy,
        })
        .where(eq(FAQS.id, id))
        .returning()

      return res
    }),

  editFaqsCategory: publicProcedure
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        icon: z.string().nullable(),
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, title, icon, modifiedBy } = input

      const [res] = await DB.update(FAQ_CATEGORIES)
        .set({
          title,
          icon,
          modifiedBy,
        })
        .where(eq(FAQ_CATEGORIES.id, id))
        .returning()

      return res
    }),

  deleteFaqs: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(FAQS).where(eq(FAQS.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),

  deleteFaqsCategory: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      const deleted = await DB.delete(FAQ_CATEGORIES).where(eq(FAQ_CATEGORIES.id, id)).returning()

      if (deleted.length === 0) return { error: "NOT_FOUND" }
      return { error: null }
    }),
})
