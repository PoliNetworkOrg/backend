import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"
import { TRUSTED_ORIGINS } from "./constants"
import { isValidIban } from "./people/iban"

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
    PUBLIC_URL: z.string().default(`http://localhost:${PORT}`),
    TRUSTED_ORIGINS: z
      .string()
      .default(TRUSTED_ORIGINS.join(","))
      .transform((s) => s.split(","))
      .pipe(z.array(z.string())),

    // secrets/encryption
    BETTER_AUTH_SECRET: z.string().min(32),
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

    // People configuration is backend-owned; no browser can choose officers, bank details or receipt identity.
    PEOPLE_PRESIDENT_ID: z
      .string()
      .regex(/^P-\d{4}$/)
      .optional(),
    PEOPLE_VICE_PRESIDENT_ID: z
      .string()
      .regex(/^P-\d{4}$/)
      .optional(),
    PEOPLE_FEE_CENTS: z.coerce.number().int().min(1).max(100_000).default(1000),
    PEOPLE_BENEFICIARY: z.string().max(200).default("PoliNetwork APS"),
    PEOPLE_IBAN: z
      .string()
      .regex(/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/)
      .refine(isValidIban, "PEOPLE_IBAN must have a valid country length and checksum")
      .optional(),
    PEOPLE_LEGAL_NAME: z.string().max(200).optional(),
    PEOPLE_ADDRESS: z.string().max(300).optional(),
    PEOPLE_TAX_CODE: z
      .string()
      .regex(/^\d{11}$/)
      .optional(),

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
    /**
     * RFC v3 §13 rollback switch. "deny" (Phase 5) refuses requests and sockets without a token;
     * "allow" lets anonymous requests run procedures that do not record an actor, with no permissions.
     */
    LEGACY_ANONYMOUS: z.enum(["allow", "deny"]).default("deny"),

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
