import "dotenv/config";

import type { Config } from "drizzle-kit";

export default {
	schema: "./src/db/web/schema/*",
	out: "./drizzle/web",
  dialect: "postgresql",
	dbCredentials: {
    database: process.env.DB_NAME_WEB!,
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    ssl: false,
	},
} satisfies Config;
