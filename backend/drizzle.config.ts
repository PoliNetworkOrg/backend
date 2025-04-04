import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/schema/*",
	out: "./drizzle",
  dialect: "postgresql",
  verbose: true,
	dbCredentials: {
    database: process.env.DB_NAME!,
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    ssl: false,
	},
} satisfies Config;

