import web from "./web"
import tg from "./tg"

export const DB = {
  WEB: web.db,
  TG: tg.db,
}

export const SCHEMA = {
  WEB: web.schema,
  TG: tg.schema,
}
