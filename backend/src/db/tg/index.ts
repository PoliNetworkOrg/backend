import { drizzle } from "drizzle-orm/node-postgres";
import { makeConnection } from "../connection";
import "dotenv/config"
import * as testSchema from "./schema/test"
import * as groupsSchema from "./schema/groups"

const schema = { ...groupsSchema, ...testSchema }
const db = drizzle({
  connection: makeConnection(process.env.DB_NAME_TG!),
  schema,
});

export default { db, schema };
