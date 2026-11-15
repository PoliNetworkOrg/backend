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
