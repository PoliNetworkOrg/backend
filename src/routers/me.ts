import { TRPCError } from "@trpc/server"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

export const meRouter = createTRPCRouter({
  /**
   * The signed-in dashboard user's own permissions from the access snapshot (RFC v3 §8.2, §11.3).
   * Drives the dashboard UI; the backend still checks every call. Empty while the snapshot is stale.
   */
  access: policy({ user: { scope: SCOPE.admin } }, { tokenOnly: true }).query(({ ctx }) => {
    if (ctx.actor?.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
    const subject = ctx.access?.subjectBySub(ctx.actor.sub)
    const index = ctx.access?.current() ?? null
    return {
      sub: ctx.actor.sub,
      telegramId: ctx.actor.telegramId,
      permissions: index && subject ? index.permissions(subject) : [],
      stale: !(ctx.access?.status().fresh ?? false),
    }
  }),
})
