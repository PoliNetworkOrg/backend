import { and, eq, ne, sql } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { createTRPCRouter, publicProcedure } from "@/trpc"

const GROUPS = SCHEMA.WA.waGroups

export default createTRPCRouter({
  getById: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .query(async ({ input }) => {
      const res = await DB.select()
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(t.id, input.id))

      if (res.length === 0) return null
      return res[0]
    }),

  getByInviteLink: publicProcedure
    .input(
      z.object({
        inviteLink: z.url(),
      })
    )
    .query(async ({ input }) => {
      const res = await DB.select()
        .from(GROUPS)
        .limit(1)
        .where((t) => eq(t.link, input.inviteLink))

      if (res.length === 0) return null
      return res[0]
    }),

  create: publicProcedure
    .input(
      z.array(
        z.object({
          title: z.string(),
          id: z.number(),
          link: z.url({ hostname: /^t\.me$/ }),
        })
      )
    )
    .output(z.array(z.number()))
    .mutation(async ({ input }) => {
      for (const group of input) {
        await DB.delete(GROUPS).where(and(eq(GROUPS.link, group.link), ne(GROUPS.id, group.id)))
      }

      const rows = await DB.insert(GROUPS)
        .values(input)
        .onConflictDoUpdate({
          target: GROUPS.id,
          set: {
            // this means: use the new value
            title: sql.raw(`excluded.${GROUPS.title.name}`),
            link: sql.raw(`excluded.${GROUPS.link.name}`),
          },
        })
        .returning()
      return rows.map((r) => r.id)
    }),

  delete: publicProcedure
    .input(
      z.object({
        id: z.number(),
      })
    )
    .output(z.boolean())
    .mutation(async ({ input }) => {
      const rows = await DB.delete(GROUPS).where(eq(GROUPS.id, input.id)).returning()
      return rows.length === 1
    }),

  setHide: publicProcedure
    .input(
      z.object({
        id: z.number(),
        hide: z.boolean(),
      })
    )
    .mutation(async ({ input }) => {
      const rows = await DB.update(GROUPS).set({ hide: input.hide }).where(eq(GROUPS.id, input.id)).returning()

      return rows.length === 1
    }),
})
