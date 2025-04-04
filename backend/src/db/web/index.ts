import { drizzle } from "drizzle-orm/node-postgres";
import { makeConnection } from "../connection";
import * as testSchema from "./schema/test";

const dbName = process.env.DB_NAME_WEB!
const schema = { ...testSchema }
const db = drizzle({
  connection: makeConnection(dbName),
  schema,
});

export default { dbName, schema, db }
