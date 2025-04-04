import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/tg/schema/*",
	out: "./drizzle/tg",
  dialect: "postgresql",
  verbose: true,
	dbCredentials: {
    database: process.env.DB_NAME_TG!,
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    ssl: false,
	},
} satisfies Config;

