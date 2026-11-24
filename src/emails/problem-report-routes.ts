import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"
import type { RequestAuth } from "@/idp/auth"
import { SCOPE } from "@/idp/policies"

export const problemReportSchema = z
  .object({
    email: z.email().trim().max(254),
    subject: z
      .string()
      .trim()
      .min(5)
      .max(120)
      .refine((value) => !/[\r\n]/.test(value)),
    description: z.string().trim().min(20).max(5000),
  })
  .strict()
export type ProblemReport = z.infer<typeof problemReportSchema>

/** Only the website's service token can invoke this fixed-recipient mail endpoint. */
export function problemReportRoutes({
  websiteClientId,
  authenticate,
  reserveSlot,
  send,
}: {
  websiteClientId: string | undefined
  authenticate: (authorization?: string) => Promise<RequestAuth>
  reserveSlot: (email: string) => Promise<number>
  send: (report: ProblemReport) => Promise<void>
}) {
  const app = new Hono()
  app.use("*", bodyLimit({ maxSize: 24 * 1024 }))
  app.post("/", async (c) => {
    c.header("Cache-Control", "no-store")
    const auth = await authenticate(c.req.header("authorization"))
    if (auth.kind === "rejected") return c.json({ error: "Unauthorized" }, auth.status)
    if (!websiteClientId) return c.json({ error: "Report service unavailable" }, 503)
    if (auth.actor.kind !== "service" || auth.actor.client !== websiteClientId || !auth.scopes.has(SCOPE.publicRead))
      return c.json({ error: "Forbidden" }, 403)
    let body: unknown
    try {
      body = await c.req.json()
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      return c.json({ error: "Invalid report" }, 400)
    }
    const parsed = problemReportSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: "Invalid report" }, 400)
    try {
      const retryAfter = await reserveSlot(parsed.data.email)
      if (retryAfter > 0) {
        c.header("Retry-After", String(retryAfter))
        return c.json({ error: "Too many reports" }, 429)
      }
    } catch {
      return c.json({ error: "Report service unavailable" }, 503)
    }
    try {
      await send(parsed.data)
      return c.body(null, 204)
    } catch {
      return c.json({ error: "Email delivery failed" }, 502)
    }
  })
  return app
}
