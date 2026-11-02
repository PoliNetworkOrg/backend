import { DB } from "@/db"
import { env } from "@/env"
import { logger } from "@/logger"
import { regulationsEmanation } from "@/regulations"
import { pgDeliveryLog } from "./github-webhook"
import { createPublicRouter } from "./router"
import { buildPublicRoutes } from "./routes"

export const publicRoutes = createPublicRouter(
  buildPublicRoutes({
    githubWebhookSecret: env.REGULATIONS_GITHUB_WEBHOOK_SECRET,
    deliveries: pgDeliveryLog(DB),
    onGitHubEvent: async (event, payload) => {
      await regulationsEmanation?.onWebhook(event, payload as never)
    },
    onError: (err, event) => logger.error({ err, event }, "[PUBLIC] GitHub webhook not handled"),
  })
)
