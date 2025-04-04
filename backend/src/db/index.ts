import { schema as webSchema } from "./schema/web";
import { schema as tgSchema } from "./schema/tg";
import { db } from "./db";

export const DB = db;
export const SCHEMA = {
  WEB: webSchema,
  TG: tgSchema,
};
