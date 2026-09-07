import { pgTableCreator } from "drizzle-orm/pg-core"

export const createTable = {
  common: pgTableCreator((tableName) => `common_${tableName}`),
  auth: pgTableCreator((tableName) => `auth_${tableName}`),
  tg: pgTableCreator((tableName) => `tg_${tableName}`),
  wa: pgTableCreator((tableName) => `wa_${tableName}`),
  web: pgTableCreator((tableName) => `web_${tableName}`),
}
