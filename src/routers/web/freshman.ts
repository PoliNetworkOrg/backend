import { TRPCError } from "@trpc/server"
import { asc, eq, inArray, sql } from "drizzle-orm"
import { audit } from "@/audit/option"
import { DB, SCHEMA } from "@/db"
import { authorOf, modifiedByColumns } from "@/idp/author"
import { dashboard, publicData } from "@/idp/policies"
import { freshmanFaqCount, freshmanSlots } from "@/routers/web/freshman/constants"
import {
  freshmanContentOutput,
  moveFreshmanCardInput,
  selectFreshmanFaqInput,
  updateFreshmanCardInput,
  updateFreshmanTelegramCardInput,
} from "@/routers/web/freshman/validation"
import { createTRPCRouter, policy } from "@/trpc"

const CARDS = SCHEMA.WEB.freshmanCards
const FEATURED = SCHEMA.WEB.freshmanFaqs
const FAQS = SCHEMA.WEB.faqs
const GROUPS = SCHEMA.TG.groups

export default createTRPCRouter({
  getContent: policy(publicData)
    .output(freshmanContentOutput)
    .query(async () => {
      // A repeatable snapshot prevents a multi-row swap from appearing partially applied.
      return DB.transaction(
        async (tx) => {
          const cards = await tx
            .select({
              card: CARDS,
              group: { telegramId: GROUPS.telegramId, title: GROUPS.title, link: GROUPS.link, hide: GROUPS.hide },
            })
            .from(CARDS)
            .leftJoin(GROUPS, eq(CARDS.telegramGroupId, GROUPS.telegramId))
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
          const rows = freshmanSlots.map((slot) => {
            const row = cards.find(({ card }) => card.id === slot.id)
            if (!row)
              throw new TRPCError({
                code: "INTERNAL_SERVER_ERROR",
                message: "Freshman content is not initialized. Apply the database migration.",
              })
            return { slot, ...row }
          })
          const resources = rows
            .filter(({ slot }) => slot.section === "resources")
            .map(({ slot, card }) => ({
              id: slot.id,
              group: slot.group,
              title: card.title,
              description: card.description,
              icon: card.icon,
              href: card.href,
            }))
          const telegram = rows
            .filter(({ slot }) => slot.section === "telegram")
            .map(({ slot, card, group }) => ({
              id: slot.id,
              group: slot.group,
              title: card.title || (group?.title ?? ""),
              description: card.description,
              icon: card.icon,
              // A linked group is the only source of the slot's link; the stored one is a legacy fallback.
              href: group ? (group.link ?? "") : card.href,
              customTitle: card.title,
              telegramGroup: group,
            }))
          return { resources, telegram, faqs: featured }
        },
        { isolationLevel: "repeatable read", accessMode: "read only" }
      )
    }),

  updateCard: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(updateFreshmanCardInput)
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input
      const { before, after } = await DB.transaction(async (tx) => {
        const [before] = await tx.select().from(CARDS).where(eq(CARDS.id, id)).for("update")
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "The website slot is not initialized." })
        const [after] = await tx
          .update(CARDS)
          .set({ ...fields, ...modifiedByColumns(authorOf(ctx.actor)) })
          .where(eq(CARDS.id, id))
          .returning()
        return { before, after }
      })
      ctx.audit.set({ target: { type: "web.freshmanCard", id }, before, after })
      return { error: null }
    }),

  updateTelegramCard: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(updateFreshmanTelegramCardInput)
    .mutation(async ({ input, ctx }) => {
      const { id, title, icon, telegramGroupId } = input
      const { before, after } = await DB.transaction(async (tx) => {
        const [before] = await tx.select().from(CARDS).where(eq(CARDS.id, id)).for("update")
        if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "The website slot is not initialized." })
        const [group] = await tx
          .select({ link: GROUPS.link })
          .from(GROUPS)
          .where(eq(GROUPS.telegramId, telegramGroupId))
          .for("key share")
        if (!group) throw new TRPCError({ code: "NOT_FOUND", message: "This Telegram group is not in the database." })
        if (!group.link)
          throw new TRPCError({ code: "BAD_REQUEST", message: "This Telegram group has no invite link yet." })
        const [after] = await tx
          .update(CARDS)
          .set({ title, icon, telegramGroupId, href: "", ...modifiedByColumns(authorOf(ctx.actor)) })
          .where(eq(CARDS.id, id))
          .returning()
        return { before, after }
      })
      ctx.audit.set({ target: { type: "web.freshmanCard", id }, before, after })
      return { error: null }
    }),

  moveCard: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(moveFreshmanCardInput)
    .mutation(async ({ input, ctx }) => {
      const index = freshmanSlots.findIndex((slot) => slot.id === input.id)
      const slot = freshmanSlots[index]
      const next = freshmanSlots[index + input.direction]
      if (!next || next.group !== slot.group)
        throw new TRPCError({ code: "BAD_REQUEST", message: "Cards can only move within their website section." })
      const author = modifiedByColumns(authorOf(ctx.actor))
      const { before, after } = await DB.transaction(async (tx) => {
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
          telegramGroupId: row.telegramGroupId,
          ...author,
        })
        const first = await tx.update(CARDS).set(values(target)).where(eq(CARDS.id, current.id)).returning()
        const second = await tx.update(CARDS).set(values(current)).where(eq(CARDS.id, target.id)).returning()
        return { before: rows, after: [...first, ...second] }
      })
      ctx.audit.set({ target: { type: "web.freshmanCard", id: input.id }, before, after })
      return { error: null }
    }),

  selectFaq: policy(dashboard("web:content:write"))
    .meta(audit.full())
    .input(selectFreshmanFaqInput)
    .mutation(async ({ input, ctx }) => {
      const author = modifiedByColumns(authorOf(ctx.actor))
      const { before, after } = await DB.transaction(async (tx) => {
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
        if (current.faqId === input.faqId) return { before: [current], after: [current] }
        const existing = rows.find((row) => row.faqId === input.faqId)
        if (existing) {
          // Reinsert the pair atomically so the declared immediate unique constraint also permits swaps.
          // Preserve each slot's creation metadata and record this edit on both positions.
          await tx.delete(FEATURED).where(inArray(FEATURED.position, [current.position, existing.position]))
          const updatedAt = new Date()
          const after = await tx
            .insert(FEATURED)
            .values([
              { ...current, faqId: existing.faqId, ...author, updatedAt },
              { ...existing, faqId: current.faqId, ...author, updatedAt },
            ])
            .returning()
          return { before: [current, existing], after }
        } else {
          const after = await tx
            .update(FEATURED)
            .set({ faqId: input.faqId, ...author })
            .where(eq(FEATURED.position, input.position))
            .returning()
          return { before: [current], after }
        }
      })
      ctx.audit.set({ target: { type: "web.freshmanFaq", id: input.position }, before, after })
      return { error: null }
    }),
})
