import { schema as webSchema } from "./schema/web";
import { schema as tgSchema } from "./schema/tg";
import { schema as authSchema } from "./schema/auth";
import { db } from "./db";

export const DB = db;
export const SCHEMA = {
  WEB: webSchema,
  TG: tgSchema,
  AUTH: authSchema,
};
