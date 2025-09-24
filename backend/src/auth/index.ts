import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { AUTH_PATH } from "@/constants"
import { SCHEMA } from "@/db"
import { db } from "@/db/db"
import { env } from "@/env"
import { telegramPlugin } from "./plugins/telegram"

export const auth = betterAuth({
  basePath: AUTH_PATH,
  baseURL: env.PUBLIC_URL,
  trustedOrigins: env.TRUSTED_ORIGINS,
  plugins: [telegramPlugin()],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: SCHEMA.AUTH.users,
      account: SCHEMA.AUTH.accounts,
      session: SCHEMA.AUTH.sessions,
      verification: SCHEMA.AUTH.verifications,
    },
  }),
  advanced:
    env.NODE_ENV === "production"
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: ".polinetwork.org", // Domain with a leading period
          },
          defaultCookieAttributes: {
            secure: true,
            httpOnly: true,
            sameSite: "none", // Allows CORS-based cookie sharing across subdomains
            partitioned: true, // New browser standards will mandate this for foreign cookies
          },
        }
      : undefined,
  cookieCache: {
    enabled: true,
    maxAge: 5 * 60, // Cache duration in seconds
  },
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
    },
  },
})
