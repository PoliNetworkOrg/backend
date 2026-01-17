import { createEnv } from "@t3-oss/env-core"
import { z } from "zod"
import { TRUSTED_ORIGINS } from "./constants"

const PORT = 3000

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

    // auth providers
    GITHUB_CLIENT_ID: z.string(),
    GITHUB_CLIENT_SECRET: z.string(),

    // main postgres db
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().min(1).max(65535).default(5432),
    DB_USER: z.string().min(1),
    DB_PASS: z.string().min(1),
    DB_NAME: z.string().min(3).default("polinetwork_backend"),

    // Azure
    AZURE_TENANT_ID: z.string(),
    AZURE_CLIENT_ID: z.string(),
    AZURE_CLIENT_SECRET: z.string(),
    AZURE_EMAIL_SENDER: z.email().default("noreply@polinetwork.org"),

    // env config
    NODE_ENV: z.enum(["development", "production"]).default("development"),
    LOG_LEVEL: z.string().default("DEBUG"),
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
