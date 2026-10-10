import { z } from "zod"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import { activeGrantByUser } from "@/utils/grants"

// Telegram user IDs fit in 52 bits; anything outside the safe-integer range is not one.
const telegramId = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^[1-9]\d{0,15}$/)
      .transform(Number),
  ])
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER))
  .transform(String)

export default createTRPCRouter({
  /**
   * Who each Telegram user is in the IdP, the permissions they hold now and any active grant
   * (RFC v3 §6.3, §10.2). The bot uses it for actor and target checks. Permissions are empty when
   * the snapshot is stale or the user has not linked Telegram.
   */
  resolve: policy({ service: { scope: SCOPE.tgRead }, telegram: { scope: SCOPE.tgRead } }, { tokenOnly: true })
    .input(z.object({ telegramIds: z.array(telegramId).min(1).max(100) }))
    .query(async ({ input, ctx }) => {
      const ids = [...new Set(input.telegramIds)]
      const now = new Date()
      const grants = await activeGrantByUser(ids.map(Number), now)
      const index = ctx.access?.current() ?? null
      const result: Record<string, { sub: string | null; permissions: string[]; grant: { validUntil: Date } | null }> =
        {}
      for (const id of ids) {
        const subject = ctx.access?.subjectByTelegramId(id)
        const grant = grants.get(Number(id))
        result[id] = {
          sub: subject?.sub ?? null,
          permissions: index && subject ? index.permissions(subject, now.getTime()) : [],
          grant: grant ? { validUntil: grant.validUntil } : null,
        }
      }
      return result
    }),
})
