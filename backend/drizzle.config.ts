import type { Config } from "drizzle-kit";
import { env } from "./src/env";

export default {
	schema: "./src/db/schema/*",
	out: "./drizzle",
  dialect: "postgresql",
  verbose: true,
	dbCredentials: {
    database: env.DB_NAME,
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASS,
    ssl: false,
	},
} satisfies Config;

