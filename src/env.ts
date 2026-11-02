import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"

const PORT = 3000
const NODE_ENV = z.enum(["development", "production", "test"])
const nodeEnv: z.infer<typeof NODE_ENV> = process.env.NODE_ENV
  ? (process.env.NODE_ENV as z.infer<typeof NODE_ENV>)
  : "development"

// coerce is needed for non-string values, because k8s supports only string env
export const env = createEnv({
  server: {
    // server config
    PORT: z.coerce.number().min(1).max(65535).default(PORT),

    // secrets/encryption
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[A-Fa-f0-9]+$/, "The string must be a valid hex string")
      .min(64)
      .max(1024),

    // main postgres db
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().min(1).max(65535).default(5432),
    DB_USER: z.string().min(1),
    DB_PASS: z.string().min(1),
    DB_NAME: z.string().min(3).default("polinetwork_backend"),

    // main redis
    REDIS_HOST: z.string().min(1).optional(),
    REDIS_PORT: z.coerce.number().min(1).max(65535).default(6379),
    REDIS_USERNAME: z.string().min(1).optional(),
    REDIS_PASSWORD: z.string().min(1).optional(),

    // Azure
    AZURE_TENANT_ID: z.string().min(1).optional(),
    AZURE_CLIENT_ID: z.string().min(1).optional(),
    AZURE_CLIENT_SECRET: z.string().min(1).optional(),
    AZURE_EMAIL_SENDER: z.email().default("noreply@polinetwork.org"),
    AZURE_BLOB_STORAGE_ACCOUNT: z.string().default("polinetworksa"),
    AZURE_BLOB_STORAGE_CONTAINER: z.string().default("file-blobs"),

    // E-signing (CIE). The drives are the OneDrive/SharePoint libraries whose folders the dashboard browses; without
    // Azure credentials in-memory development drives are used. Graph needs Files.ReadWrite.All (or Sites.Selected).
    /** JSON array of `{ id, label, driveId, rootId? }`; `rootId` is the folder the dashboard may use (whole drive). */
    ESIGN_DRIVES: z
      .string()
      .default("[]")
      .transform((value, ctx) => {
        try {
          return JSON.parse(value)
        } catch {
          ctx.addIssue({ code: "custom", message: "ESIGN_DRIVES must be a JSON array" })
          return z.NEVER
        }
      })
      .pipe(
        z
          .array(
            z.object({
              id: z.string().regex(/^[a-z0-9-]{1,40}$/, "lowercase letters, digits and dashes"),
              label: z.string().min(1).max(80),
              driveId: z.string().min(1),
              rootId: z.string().min(1).default("root"),
            })
          )
          .refine((drives) => new Set(drives.map((d) => d.id)).size === drives.length, "Each drive needs its own id")
      ),
    /** Dashboard origin, for links in signature emails. */
    ESIGN_DASHBOARD_URL: z.url().default("https://admin.polinetwork.org"),
    /** Accept signing certificates not issued by the CIE CAs, e.g. the agent's development key. */
    ESIGN_ALLOW_TEST_CERTIFICATES: z
      .enum(["true", "false"])
      .optional()
      .transform((v) => (v === undefined ? nodeEnv !== "production" : v === "true")),

    /** OCSP for CIE certificates: require (refuse when unknown), prefer (refuse only revoked), off. */
    ESIGN_REVOCATION: z.enum(["require", "prefer", "off"]).default("prefer"),

    // PoliNetwork IdP (RFC v3 §6, §12). Token authentication is enabled when IDP_PUBLIC_URL and
    // OAUTH_BACKEND_RESOURCE_URI are set; snapshot pulls also need the internal resource and the
    // backend client's credentials. Without them every permission check denies.
    IDP_PUBLIC_URL: z.url().optional(),
    /** In-cluster address for requests; identifiers always come from IDP_PUBLIC_URL. */
    IDP_INTERNAL_URL: z.url().optional(),
    OAUTH_BACKEND_RESOURCE_URI: z.url().optional(),
    OAUTH_INTERNAL_RESOURCE_URI: z.url().optional(),
    OAUTH_BACKEND_CLIENT_ID: z.string().min(1).optional(),
    /** Registered Telegram service client ID; required to accept token-authenticated bot sockets. */
    OAUTH_BOT_CLIENT_ID: z.string().min(1).optional(),
    /** The backend client's private signing key as a JWK (JSON), with `kid` and `alg`. */
    OAUTH_BACKEND_PRIVATE_JWK: z.string().min(1).optional(),
    IDP_SNAPSHOT_POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(30_000),

    // Regulations editor. Every part is optional: without it the matching feature answers PRECONDITION_FAILED.
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
    REGULATIONS_GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
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
    REGULATIONS_DIRETTIVO_EMAIL: z.email().default("direttivo@polinetwork.org"),
    REGULATIONS_TELEGRAM_CHAT_ID: z.coerce.number().int().optional(),
    REGULATIONS_TELEGRAM_TOPIC_ID: z.coerce.number().int().optional(),
    /** The dashboard's page of a draft, for the email: `{documentKey}` and `{draftId}` are replaced. */
    REGULATIONS_WEB_URL: z.string().optional(),

    // env config
    NODE_ENV: NODE_ENV.default(nodeEnv),
    LOG_LEVEL: z.string().default("DEBUG"),
    USE_DEV_MAILER: z.coerce.boolean().default(true),
  },

  runtimeEnv: process.env,
  /**
   * By default, this library will feed the environment variables directly to
   * the Zod validator.
   *
   * This means that if you have an empty string for a value that is supposed
   * to be a number (e.g. `PORT=` in a ".env" file), Zod will incorrectly flag
   * it as a type mismatch violation. Additionally, if you have an empty string
   * for a value that is supposed to be a string with a default value (e.g.
   * `DOMAIN=` in an ".env" file), the default value will never be applied.
   *
   * In order to solve these issues, we recommend that all new projects
   * explicitly specify this option as true.
   */
  emptyStringAsUndefined: true,
})
