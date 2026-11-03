import { asc, eq, sql } from "drizzle-orm"
import z from "zod"
import { DB, SCHEMA } from "@/db"
import { authorOf, createdByColumns, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const FAQS = SCHEMA.WEB.faqs

const FAQ_CATEGORIES = SCHEMA.WEB.faqCategories
const FEATURED = SCHEMA.WEB.freshmanFaqs

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

  addFaqs: policy(dashboard("web:content:write"))
    .input(
      z.object({
        titleIt: z.string(),
        titleEn: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
        categoryId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { titleIt, titleEn, descriptionIt, descriptionEn, categoryId } = input

      const [res] = await DB.insert(FAQS)
        .values({
          titleIt,
          titleEn,
          descriptionIt,
          descriptionEn,
          categoryId,
          ...createdByColumns(authorOf(ctx.actor)),
        })
        .returning()

      return res
    }),

  addFaqsCategory: policy(dashboard("web:content:write"))
    .input(
      z.object({
        titleIt: z.string(),
        titleEn: z.string(),
        icon: z.string().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { titleIt, titleEn, icon } = input

      const [res] = await DB.insert(FAQ_CATEGORIES)
        .values({
          titleIt,
          titleEn,
          icon,
          ...createdByColumns(authorOf(ctx.actor)),
        })
        .returning()

      return res
    }),

  editFaqs: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number(),
        titleIt: z.string(),
        titleEn: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
        categoryId: z.number(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, titleIt, titleEn, descriptionIt, descriptionEn, categoryId } = input

      const [res] = await DB.update(FAQS)
        .set({
          titleIt,
          titleEn,
          descriptionIt,
          descriptionEn,
          categoryId,
          ...modifiedByColumns(authorOf(ctx.actor)),
        })
        .where(eq(FAQS.id, id))
        .returning()

      if (!res) return { error: "NOT_FOUND" }
      return res
    }),

  editFaqsCategory: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number(),
        titleIt: z.string(),
        titleEn: z.string(),
        icon: z.string().nullable(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { id, titleIt, titleEn, icon } = input

      const [res] = await DB.update(FAQ_CATEGORIES)
        .set({
          titleIt,
          titleEn,
          icon,
          ...modifiedByColumns(authorOf(ctx.actor)),
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
      return DB.transaction(async (tx) => {
        // Match selectFaq's lock order so a FAQ cannot become selected between this check and deletion.
        await tx.execute(sql`LOCK TABLE ${FEATURED} IN SHARE ROW EXCLUSIVE MODE`)
        const [featured] = await tx
          .select({ position: FEATURED.position })
          .from(FEATURED)
          .where(eq(FEATURED.faqId, id))
          .limit(1)
        if (featured) return { error: "FEATURED_FAQ" }
        const deleted = await tx.delete(FAQS).where(eq(FAQS.id, id)).returning()

        if (deleted.length === 0) return { error: "NOT_FOUND" }
        return { error: null }
      })
    }),

  deleteFaqsCategory: policy(dashboard("web:content:write"))
    .input(
      z.object({
        id: z.number(),
      })
    )
    .mutation(async ({ input }) => {
      const { id } = input
      return DB.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${FEATURED} IN SHARE ROW EXCLUSIVE MODE`)
        const [featured] = await tx
          .select({ position: FEATURED.position })
          .from(FEATURED)
          .innerJoin(FAQS, eq(FEATURED.faqId, FAQS.id))
          .where(eq(FAQS.categoryId, id))
          .limit(1)
        if (featured) return { error: "FEATURED_FAQ" }
        const deleted = await tx.delete(FAQ_CATEGORIES).where(eq(FAQ_CATEGORIES.id, id)).returning()

        if (deleted.length === 0) return { error: "NOT_FOUND" }
        return { error: null }
      })
    }),
})
