import { timingSafeEqual } from "node:crypto"
import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"

const base = z.object({
  id: z.string().min(1).max(400),
  to: z.email(),
  name: z.string().min(1).max(200),
  url: z.url(),
})
const schema = z.discriminatedUnion("kind", [
  base.extend({ kind: z.literal("draw"), exchange: z.string().max(200), budget: z.string().max(60) }),
  base.extend({
    kind: z.literal("reassigned"),
    withdrawnName: z.string().min(1).max(200),
    hasNewMatch: z.boolean(),
    reason: z.enum(["withdrawn", "unconfirmed"]).optional(),
  }),
  base.extend({ kind: z.literal("confirmation-reminder"), closesAt: z.number().int().positive() }),
  base.extend({ kind: z.literal("removed"), closesAt: z.number().int().positive() }),
])
export type SecretSantaEmailRequest = z.infer<typeof schema>

/** A narrowly scoped service credential permits only the four Secret Santa templates. */
export function secretSantaEmailRoutes({
  token,
  publicUrl,
  send,
}: {
  token?: string
  publicUrl: string
  send: (mail: SecretSantaEmailRequest) => Promise<void>
}) {
  const app = new Hono()
  app.use("*", bodyLimit({ maxSize: 12 * 1024 }))
  app.post("/", async (c) => {
    c.header("Cache-Control", "no-store")
    if (!token) return c.json({ error: "Secret Santa mail transport is disabled" }, 503)
    const supplied = Buffer.from(c.req.header("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return c.json({ error: "Unauthorized" }, 401)
    const parsed = schema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json({ error: "Invalid Secret Santa email" }, 400)
    const url = new URL(parsed.data.url)
    if (url.origin !== new URL(publicUrl).origin || url.pathname !== "/secret-santa" || url.username || url.password)
      return c.json({ error: "Invalid Secret Santa link" }, 400)
    try {
      await send(parsed.data)
      return c.body(null, 204)
    } catch {
      return c.json({ error: "Secret Santa email delivery failed" }, 502)
    }
  })
  return app
}
