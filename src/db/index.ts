import { db } from "./db"
import { schema as authSchema } from "./schema/auth"
import { schema as commonSchema } from "./schema/common"
import { schema as tgSchema } from "./schema/tg"
import { views } from "./schema/views"
import { schema as waSchema } from "./schema/wa"
import { schema as webSchema } from "./schema/web"

export const DB = db
export const SCHEMA = {
  AUTH: authSchema,
  COMMON: commonSchema,
  TG: tgSchema,
  WA: waSchema,
  WEB: webSchema,
}
export const VIEWS = {
  GROUPS: views,
}
