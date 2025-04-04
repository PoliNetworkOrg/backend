import { drizzle } from "drizzle-orm/node-postgres";
import { schema } from "./schema";

export const db = drizzle({
  connection: {
    database: process.env.DB_NAME!,
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    ssl: false,
  },
  schema,
});
