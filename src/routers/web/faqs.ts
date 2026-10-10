import { asc, eq } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA } from "@/db"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, legacyProcedure, policy } from "@/trpc"

const FAQS = SCHEMA.WEB.faqs

const FAQ_CATEGORIES = SCHEMA.WEB.faqCategories

export default createTRPCRouter({
  getAllFaqs: policy(publicData)
    .output(
      z.array(
        z.object({
          categoryId: z.number(),
          titleIt: z.string(),
          titleEn: z.string(),
          icon: z.string().nullable(),
          faqs: z.array(
            z.object({
              faqId: z.number(),
              titleIt: z.string(),
              titleEn: z.string(),
              descriptionIt: z.string(),
              descriptionEn: z.string(),
            })
          ),
        })
      )
    )
    .query(async () => {
      const faqs = await DB.select().from(FAQS)
      const categories = await DB.select().from(FAQ_CATEGORIES).orderBy(asc(FAQ_CATEGORIES.id))

      const result = categories.map((c) => ({
        categoryId: c.id,
        titleIt: c.titleIt,
        titleEn: c.titleEn,
        icon: c.icon,
        faqs: faqs
          .filter((f) => f.categoryId === c.id)
          .map((f) => ({
            faqId: f.id,
            titleIt: f.titleIt,
            titleEn: f.titleEn,
            descriptionIt: f.descriptionIt,
            descriptionEn: f.descriptionEn,
          })),
      }))

      return result
    }),

  addFaqs: legacyProcedure
    .input(
      z.object({
        titleIt: z.string(),
        titleEn: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
        categoryId: z.number(),
        createdBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { titleIt, titleEn, descriptionIt, descriptionEn, categoryId, createdBy } = input

      const [res] = await DB.insert(FAQS)
        .values({
          titleIt,
          titleEn,
          descriptionIt,
          descriptionEn,
          categoryId,
          createdBy,
        })
        .returning()

      return res
    }),

  addFaqsCategory: legacyProcedure
    .input(
      z.object({
        titleIt: z.string(),
        titleEn: z.string(),
        icon: z.string().nullable(),
        createdBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { titleIt, titleEn, icon, createdBy } = input

      const [res] = await DB.insert(FAQ_CATEGORIES)
        .values({
          titleIt,
          titleEn,
          icon,
          createdBy,
        })
        .returning()

      return res
    }),

  editFaqs: legacyProcedure
    .input(
      z.object({
        id: z.number(),
        titleIt: z.string(),
        titleEn: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
        categoryId: z.number(),
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, titleIt, titleEn, descriptionIt, descriptionEn, categoryId, modifiedBy } = input

      const [res] = await DB.update(FAQS)
        .set({
          titleIt,
          titleEn,
          descriptionIt,
          descriptionEn,
          categoryId,
          modifiedBy,
        })
        .where(eq(FAQS.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  editFaqsCategory: legacyProcedure
    .input(
      z.object({
        id: z.number(),
        titleIt: z.string(),
        titleEn: z.string(),
        icon: z.string().nullable(),
        modifiedBy: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id, titleIt, titleEn, icon, modifiedBy } = input

      const [res] = await DB.update(FAQ_CATEGORIES)
        .set({
          titleIt,
          titleEn,
          icon,
          modifiedBy,
        })
        .where(eq(FAQ_CATEGORIES.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  deleteFaqs: policy(dashboard("web:content:write"))
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

  deleteFaqsCategory: policy(dashboard("web:content:write"))
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
