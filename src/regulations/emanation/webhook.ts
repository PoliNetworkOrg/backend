import { verify } from "@octokit/webhooks-methods"
import { logger } from "@/logger"
import type { EmanationService } from "./service"

/** Verifies the App's signature, then lets the emanation resume (the 30-second poll would get there anyway). */
export async function githubWebhook(req: Request, secret: string | undefined, emanation: EmanationService | null) {
  if (!secret || !emanation) return new Response(null, { status: 404 })
  const body = await req.text()
  const signature = req.headers.get("x-hub-signature-256") ?? ""
  if (!(await verify(secret, body, signature).catch(() => false))) return new Response("bad signature", { status: 401 })
  const event = req.headers.get("x-github-event") ?? ""
  try {
    await emanation.onWebhook(event, JSON.parse(body))
  } catch (err) {
    logger.error({ err, event }, "[REGULATIONS] webhook handling failed")
  }
  return new Response(null, { status: 202 })
}
