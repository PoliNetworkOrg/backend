import { eq } from "drizzle-orm"
import { z } from "zod"
import { DB, SCHEMA } from "@/db"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const GROUPS = SCHEMA.WA.waGroups

export default createTRPCRouter({
  getAll: policy(dashboard("admin:access")).query(async () => {
    const results = await DB.select().from(GROUPS)
    return results
  }),

  getById: policy(dashboard("admin:access"))
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

  getByInviteLink: policy(dashboard("admin:access"))
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

  add: policy(dashboard("wa:groups:manage"))
    .input(
      z.object({
        title: z.string(),
        link: z.url({ hostname: /^chat\.whatsapp\.com$/ }),
        hide: z.boolean().default(false),
      })
    )
    .mutation(async ({ input }) => {
      const [created] = await DB.insert(GROUPS).values(input).returning()
      return created
    }),

  modify: policy(dashboard("wa:groups:manage"))
    .input(
      z.object({
        id: z.number(),
        title: z.string(),
        link: z.url({ hostname: /^chat\.whatsapp\.com$/ }),
      })
    )
    .mutation(async ({ input }) => {
      const { id, ...values } = input
      const [updated] = await DB.update(GROUPS).set(values).where(eq(GROUPS.id, id)).returning()
      return updated
    }),

  delete: policy(dashboard("wa:groups:manage"))
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

  setHide: policy(dashboard("wa:groups:manage"))
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
