import { type DeliveryLog, githubWebhookRoute } from "./github-webhook"
import type { PublicRoute } from "./router"

/**
 * Every public route of the backend, in one place. `tests/public-routes.test.ts` lists them: a route added here
 * without updating that list fails the tests, so nothing becomes public by accident.
 */
export function buildPublicRoutes(deps: {
  githubWebhookSecret: string | undefined
  deliveries: DeliveryLog
  onGitHubEvent: (event: string, payload: unknown) => Promise<void>
  onError?: (error: unknown, event: string) => void
}): PublicRoute[] {
  return [
    githubWebhookRoute({
      secret: deps.githubWebhookSecret,
      deliveries: deps.deliveries,
      handle: deps.onGitHubEvent,
      onError: deps.onError,
    }),
  ]
}
