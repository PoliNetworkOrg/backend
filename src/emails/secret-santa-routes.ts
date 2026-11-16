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
  base
    .extend({
      kind: z.literal("reassigned"),
      // Empty only for organizer corrections, whose email never names anyone (e.g. a readmitted person).
      withdrawnName: z.string().max(200),
      hasNewMatch: z.boolean(),
      reason: z.enum(["withdrawn", "unconfirmed", "admin"]).optional(),
    })
    .refine((mail) => mail.reason === "admin" || mail.withdrawnName.length > 0, {
      message: "withdrawnName is required unless the change was made by the organizers",
      path: ["withdrawnName"],
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
    const body: unknown = await c.req.json().catch((error: unknown) => error)
    // Without Content-Length, bodyLimit only fails while the body is read: report it as such, not as bad JSON.
    if (body instanceof Error && body.name === "BodyLimitError") return c.json({ error: "Payload Too Large" }, 413)
    const parsed = schema.safeParse(body instanceof Error ? null : body)
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
