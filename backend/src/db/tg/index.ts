import { drizzle } from "drizzle-orm/node-postgres";
import { makeConnection } from "../connection";
import * as testSchema from "./schema/test"
import * as groupsSchema from "./schema/groups"

const dbName = process.env.DB_NAME_TG!
const schema = { ...groupsSchema, ...testSchema }
const db = drizzle({
  connection: makeConnection(dbName),
  schema,
});

export default { db, dbName, schema }
