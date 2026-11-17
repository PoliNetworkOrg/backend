import { z } from "zod"
import { logger } from "@/logger"

/**
 * The regulations editor's environment, kept out of the backend's own `env.ts`: every value is optional, and a
 * malformed one is logged and treated as unset (that feature answers "not configured"), so nothing here can ever stop
 * the backend from booting. Empty strings count as unset, as in `env.ts`.
 */
const fields = {
  /** Public websocket URL of the collab service, handed to browsers with each ticket. */
  REGULATIONS_COLLAB_PUBLIC_URL: z
    .string()
    .regex(/^wss?:\/\//)
    .optional(),
  /** In-cluster URL of the collab service's internal API. */
  REGULATIONS_COLLAB_INTERNAL_URL: z.url().optional(),
  /** Shared with the collab service (internal API). */
  REGULATIONS_INTERNAL_SECRET: z.string().min(32).optional(),
  /** The LaTeX worker, to compile published versions without an official PDF. */
  REGULATIONS_WORKER_URL: z.url().optional(),
  REGULATIONS_WORKER_SECRET: z.string().min(1).optional(),
  /** A local clone of PoliNetworkOrg/legal to import documents from (development); otherwise the GitHub App. */
  REGULATIONS_LEGAL_DIR: z.string().min(1).optional(),

  /**
   * The LLM that groups the differences by theme: `anthropic`, or `fake` (deterministic; the default outside
   * production). The model is configuration, never hardcoded.
   */
  REGULATIONS_LLM_PROVIDER: z.enum(["anthropic", "fake"]).optional(),
  REGULATIONS_LLM_MODEL: z.string().min(1).optional(),
  REGULATIONS_LLM_API_KEY: z.string().min(1).optional(),
  REGULATIONS_LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),

  /** `app`: the GitHub App on the legal repository; `fake`: in memory (the default outside production). */
  REGULATIONS_GITHUB_MODE: z.enum(["app", "fake"]).optional(),
  REGULATIONS_GITHUB_APP_ID: z.string().min(1).optional(),
  /** PEM; `\\n` escapes are accepted. */
  REGULATIONS_GITHUB_PRIVATE_KEY: z
    .string()
    .min(1)
    .optional()
    .transform((v) => v?.replace(/\\n/g, "\n")),
  /** The App's webhook secret, for `POST /public/webhooks/github`. Without it the route answers 404. */
  REGULATIONS_GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  /** Seconds between reconciliations of emanations waiting on GitHub, for webhook deliveries that got lost. */
  REGULATIONS_RECONCILE_SECONDS: z.coerce.number().int().min(5).max(3600).default(300),
  REGULATIONS_GITHUB_REPO: z
    .string()
    .regex(/^[\w.-]+\/[\w.-]+$/)
    .default("PoliNetworkOrg/legal"),
  REGULATIONS_GITHUB_BASE: z.string().min(1).default("main"),
  /** Development: where the in-memory GitHub keeps its state across restarts. */
  REGULATIONS_FAKE_GITHUB_STATE: z.string().min(1).optional(),
  /** Notifications. The sender is still to be decided: AZURE_EMAIL_SENDER unless set. */
  REGULATIONS_EMAIL_SENDER: z.email().optional(),
  REGULATIONS_EMAIL_TO: z.email().default("soci@polinetwork.org"),
  REGULATIONS_EMAIL_REPLY_TO: z.email().default("direttivo@polinetwork.org"),
  /**
   * Also in CC on the Soci's notice of an emanation (the RRI requires notifying the Collegio dei Probiviri too), e.g.
   * `direttivo@polinetwork.org,probiviri@polinetwork.org`. Comma-separated; none when unset.
   */
  REGULATIONS_EMAIL_CC: z
    .string()
    .optional()
    .transform((v) => [
      ...new Set(
        (v ?? "")
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean)
      ),
    ])
    .pipe(z.array(z.email())),
  REGULATIONS_DIRETTIVO_EMAIL: z.email().default("direttivo@polinetwork.org"),
  REGULATIONS_TELEGRAM_CHAT_ID: z.coerce.number().int().optional(),
  REGULATIONS_TELEGRAM_TOPIC_ID: z.coerce.number().int().optional(),
  /** The dashboard's page of a draft's changes, for the email (default `…/dashboard/regulations/drafts/{draftId}/diff`). */
  REGULATIONS_WEB_URL: z.string().optional(),
}

type Config = { [K in keyof typeof fields]: z.output<(typeof fields)[K]> }

export function parseRegulationsConfig(source: Record<string, string | undefined>): Config {
  const out: Record<string, unknown> = {}
  for (const [key, schema] of Object.entries(fields)) {
    const raw = source[key] === "" ? undefined : source[key]
    const parsed = schema.safeParse(raw)
    if (parsed.success) out[key] = parsed.data
    else {
      // Never the value: it may be a secret.
      logger.error({ variable: key, issue: parsed.error.issues[0]?.message }, "[REGULATIONS] invalid setting ignored")
      out[key] = schema.parse(undefined)
    }
  }
  return out as Config
}

export const regulationsConfig = parseRegulationsConfig(process.env)
