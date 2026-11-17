import { createHmac, timingSafeEqual } from "node:crypto"
import { eq, lt } from "drizzle-orm"
import { webhookDeliveries } from "@/db/schema/common/webhook-deliveries"
import type { RegulationsDb } from "@/regulations/db"
import type { PublicRoute } from "./router"

/** Constant-time check of GitHub's `X-Hub-Signature-256: sha256=<hex>` over the raw body. */
export function validGitHubSignature(secret: string, body: Uint8Array, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false
  const expected = createHmac("sha256", secret).update(body).digest()
  let given: Buffer
  try {
    given = Buffer.from(header.slice("sha256=".length), "hex")
  } catch {
    return false
  }
  return given.length === expected.length && timingSafeEqual(given, expected)
}

const DELIVERY_ID = /^[A-Za-z0-9-]{8,80}$/

/** Delivery ids handled: `claim` is false for one seen before; `forget` lets a failed one be redelivered. */
export type DeliveryLog = {
  claim(id: string, event: string): Promise<boolean>
  forget(id: string): Promise<void>
}

export function pgDeliveryLog(db: RegulationsDb, source = "github"): DeliveryLog {
  return {
    async claim(id, event) {
      const claimed = await db
        .insert(webhookDeliveries)
        .values({ id, source, event, receivedAt: new Date() })
        .onConflictDoNothing()
        .returning({ id: webhookDeliveries.id })
      return claimed.length > 0
    },
    async forget(id) {
      await db.delete(webhookDeliveries).where(eq(webhookDeliveries.id, id))
    },
  }
}

/**
 * `POST /public/webhooks/github`: the GitHub App's webhook on the legal repository (PR merged, checks, release
 * published). Authenticated by the HMAC with `REGULATIONS_GITHUB_WEBHOOK_SECRET`; each delivery id is handled once.
 * Without a secret the route answers 404, as if it didn't exist.
 */
export function githubWebhookRoute(options: {
  secret: string | undefined
  deliveries: DeliveryLog
  handle: (event: string, payload: unknown) => Promise<void>
  onError?: (error: unknown, event: string) => void
}): PublicRoute {
  return {
    method: "POST",
    path: "/public/webhooks/github",
    // GitHub caps payloads at 25 MB; pull_request, check_suite and release events are a few dozen KB.
    maxBodyBytes: 1024 * 1024,
    rateLimit: { perMinute: 120, perClientPerMinute: 60 },
    async handler({ headers, body }) {
      if (!options.secret) return Response.json({ error: "not found" }, { status: 404 })
      if (!validGitHubSignature(options.secret, body, headers.get("x-hub-signature-256")))
        return Response.json({ error: "bad signature" }, { status: 401 })
      const delivery = headers.get("x-github-delivery") ?? ""
      const event = headers.get("x-github-event") ?? ""
      if (!DELIVERY_ID.test(delivery) || !event) return Response.json({ error: "bad delivery" }, { status: 400 })
      let payload: unknown
      try {
        payload = JSON.parse(new TextDecoder().decode(body))
      } catch {
        return Response.json({ error: "bad body" }, { status: 400 })
      }
      // Claim the delivery id first: a replay (or a concurrent duplicate) is acknowledged and ignored.
      if (!(await options.deliveries.claim(delivery, event))) return Response.json({ duplicate: true }, { status: 200 })
      try {
        await options.handle(event, payload)
      } catch (error) {
        options.onError?.(error, event)
        // Forget it, so GitHub's redelivery is handled.
        await options.deliveries.forget(delivery)
        return Response.json({ error: "not handled" }, { status: 500 })
      }
      return new Response(null, { status: 202 })
    },
  }
}

export async function pruneWebhookDeliveries(db: RegulationsDb, now = new Date()) {
  await db.delete(webhookDeliveries).where(lt(webhookDeliveries.receivedAt, new Date(now.getTime() - 7 * 86_400_000)))
}
