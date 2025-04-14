import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db/db";
import { SCHEMA } from "./db";
import { env } from "./env";
import { TRUSTED_ORIGINS, AUTH_PATH } from "./constants";

export const auth = betterAuth({
  trustedOrigins: TRUSTED_ORIGINS,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: SCHEMA.AUTH.users,
      account: SCHEMA.AUTH.accounts,
      session: SCHEMA.AUTH.sessions,
      verification: SCHEMA.AUTH.verifications,
    }
  }),
  basePath: AUTH_PATH,
  baseURL: env.PUBLIC_URL,
  socialProviders: { 
    github: { 
      clientId: env.GITHUB_CLIENT_ID, 
      clientSecret: env.GITHUB_CLIENT_SECRET, 
    }, 
  }, 
});
