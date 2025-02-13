import { drizzle } from "drizzle-orm/node-postgres";
import { makeConnection } from "../connection";
import { PoolConfig } from "pg";
import * as testSchema from "./schema/test";

/**
 * Cache the database connection in development. This avoids creating a new connection on every HMR
 * update.
 */
const globalForDb = globalThis as unknown as {
  conn: PoolConfig | undefined;
};

const connection = globalForDb.conn ?? makeConnection(process.env.DB_NAME_WEB!);
if (process.env.NODE_ENV !== "production") globalForDb.conn = connection;

const schema = { ...testSchema }
const db = drizzle({
  connection,
  schema,
});

export default { schema, db } 
