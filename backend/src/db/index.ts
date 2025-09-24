import { db } from "./db"
import { schema as authSchema } from "./schema/auth"
import { schema as tgSchema } from "./schema/tg"
import { schema as webSchema } from "./schema/web"

export const DB = db
export const SCHEMA = {
  WEB: webSchema,
  TG: tgSchema,
  AUTH: authSchema,
}
