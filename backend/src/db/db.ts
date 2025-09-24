import { drizzle } from "drizzle-orm/node-postgres"
import { env } from "@/env"
import { schema } from "./schema"

export const db = drizzle({
  connection: {
    database: env.DB_NAME,
    host: env.DB_HOST,
    port: env.DB_PORT,
    user: env.DB_USER,
    password: env.DB_PASS,
    ssl: false,
  },
  schema,
})
