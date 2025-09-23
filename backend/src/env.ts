import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
import { TRUSTED_ORIGINS } from "./constants";

const PORT = 3000;

// coerce is needed for non-string values, because k8s supports only string env
export const env = createEnv({
  server: {
    PORT: z.coerce.number().min(1).max(65535).default(PORT),
    BETTER_AUTH_SECRET: z.string().min(32),
    GITHUB_CLIENT_ID: z.string(),
    GITHUB_CLIENT_SECRET: z.string(),
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().min(1).max(65535).default(5432),
    DB_USER: z.string().min(1),
    DB_PASS: z.string().min(1),
    DB_NAME: z.string().min(3).default("polinetwork_backend"),
    PUBLIC_URL: z.string().default(`http://localhost:${PORT}`),
    ENCRYPTION_KEY: z
      .string()
      .regex(/^[A-Fa-f0-9]+$/, "The string must be a valid hex string")
      .length(64),

    TRUSTED_ORIGINS: z
      .string()
      .default(TRUSTED_ORIGINS.join(","))
      .transform((s) => s.split(","))
      .pipe(z.array(z.string())),
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
});
