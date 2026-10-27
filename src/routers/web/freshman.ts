import { TRPCError } from "@trpc/server"
import { asc, eq, inArray, sql } from "drizzle-orm"
import { DB, SCHEMA } from "@/db"
import { authorOf, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { freshmanFaqCount, freshmanSlots } from "@/routers/web/freshman/constants"
import {
  freshmanContentOutput,
  moveFreshmanCardInput,
  selectFreshmanFaqInput,
  updateFreshmanCardInput,
} from "@/routers/web/freshman/validation"
import { createTRPCRouter, policy } from "@/trpc"

const CARDS = SCHEMA.WEB.freshmanCards
const FEATURED = SCHEMA.WEB.freshmanFaqs
const FAQS = SCHEMA.WEB.faqs

export default createTRPCRouter({
  getContent: policy(publicData)
    .output(freshmanContentOutput)
    .query(async () => {
      // A repeatable snapshot prevents a multi-row swap from appearing partially applied.
      return DB.transaction(
        async (tx) => {
          const cards = await tx.select().from(CARDS)
          const featured = await tx
            .select({
              faqId: FAQS.id,
              titleIt: FAQS.titleIt,
              titleEn: FAQS.titleEn,
              descriptionIt: FAQS.descriptionIt,
              descriptionEn: FAQS.descriptionEn,
            })
            .from(FEATURED)
            .innerJoin(FAQS, eq(FEATURED.faqId, FAQS.id))
            .orderBy(asc(FEATURED.position))
          const ordered = freshmanSlots.map((slot) => {
            const card = cards.find((row) => row.id === slot.id)
            if (!card)
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: "Freshman content is not initialized. Apply the database migration.",
              })
            return {
              id: slot.id,
              group: slot.group,
              title: card.title,
              description: card.description,
              icon: card.icon,
              href: card.href,
            }
          })
          return { resources: ordered.slice(0, 10), telegram: ordered.slice(10), faqs: featured }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" }
      )
    }),

  updateCard: policy(dashboard("web:content:write"))
    .input(updateFreshmanCardInput)
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input
      const [updated] = await DB.update(CARDS)
        .set({ ...fields, ...modifiedByColumns(authorOf(ctx.actor)) })
        .where(eq(CARDS.id, id))
        .returning({ id: CARDS.id })
      if (!updated) throw new TRPCError({ code: "NOT_FOUND", message: "The website slot is not initialized." })
      return { error: null }
    }),

  moveCard: policy(dashboard("web:content:write"))
    .input(moveFreshmanCardInput)
    .mutation(async ({ input, ctx }) => {
      const index = freshmanSlots.findIndex((slot) => slot.id === input.id)
      const slot = freshmanSlots[index]
      const next = freshmanSlots[index + input.direction]
      if (!next || next.group !== slot.group)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cards can only move within their website section." })
      const author = modifiedByColumns(authorOf(ctx.actor))
      await DB.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(CARDS)
          .where(inArray(CARDS.id, [slot.id, next.id]))
          .orderBy(asc(CARDS.id))
          .for("update")
        const current = rows.find((row) => row.id === slot.id)
        const target = rows.find((row) => row.id === next.id)
        if (!current || !target)
          throw new TRPCError({ code: "NOT_FOUND", message: "The website slots are not initialized." })
        const values = (row: typeof current) => ({
          title: row.title,
          description: row.description,
          href: row.href,
          icon: row.icon,
          ...author,
        })
        await tx.update(CARDS).set(values(target)).where(eq(CARDS.id, current.id))
        await tx.update(CARDS).set(values(current)).where(eq(CARDS.id, target.id))
      })
      return { error: null }
    }),

  selectFaq: policy(dashboard("web:content:write"))
    .input(selectFreshmanFaqInput)
    .mutation(async ({ input, ctx }) => {
      const author = modifiedByColumns(authorOf(ctx.actor))
      await DB.transaction(async (tx) => {
        // Serialize writes to the five slots before reading; public snapshot reads remain unblocked.
        // Catalog deletions take the same lock before checking whether a FAQ is selected.
        await tx.execute(sql`LOCK TABLE ${FEATURED} IN SHARE ROW EXCLUSIVE MODE`)
        const rows = await tx.select().from(FEATURED).orderBy(asc(FEATURED.position))
        if (rows.length !== freshmanFaqCount)
          throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "The FAQ positions are not initialized." })
        const [faq] = await tx.select({ id: FAQS.id }).from(FAQS).where(eq(FAQS.id, input.faqId)).for("key share")
        if (!faq) throw new TRPCError({ code: "NOT_FOUND", message: "This FAQ no longer exists." })
        const current = rows.find((row) => row.position === input.position)
        if (!current) throw new TRPCError({ code: "NOT_FOUND" })
        if (current.faqId === input.faqId) return
        const existing = rows.find((row) => row.faqId === input.faqId)
        if (existing) {
          // Reinsert the pair atomically so the declared immediate unique constraint also permits swaps.
          // Preserve each slot's creation metadata and record this edit on both positions.
          await tx.delete(FEATURED).where(inArray(FEATURED.position, [current.position, existing.position]))
          const updatedAt = new Date()
          await tx.insert(FEATURED).values([
            { ...current, faqId: existing.faqId, ...author, updatedAt },
            { ...existing, faqId: current.faqId, ...author, updatedAt },
          ])
        } else {
          await tx
            .update(FEATURED)
            .set({ faqId: input.faqId, ...author })
            .where(eq(FEATURED.position, input.position))
        }
      })
      return { error: null }
    }),
})
