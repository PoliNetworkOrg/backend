import { pgTableCreator } from "drizzle-orm/pg-core"

export const createTable = {
  common: pgTableCreator((tableName) => `common_${tableName}`),
  esign: pgTableCreator((tableName) => `esign_${tableName}`),
  tg: pgTableCreator((tableName) => `tg_${tableName}`),
  wa: pgTableCreator((tableName) => `wa_${tableName}`),
  web: pgTableCreator((tableName) => `web_${tableName}`),
}
