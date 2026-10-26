import { pgTableCreator } from "drizzle-orm/pg-core"

export const createTable = {
  people: pgTableCreator((tableName) => `people_${tableName}`),
  common: pgTableCreator((tableName) => `common_${tableName}`),
  esign: pgTableCreator((tableName) => `esign_${tableName}`),
  auth: pgTableCreator((tableName) => `auth_${tableName}`),
  tg: pgTableCreator((tableName) => `tg_${tableName}`),
  wa: pgTableCreator((tableName) => `wa_${tableName}`),
  web: pgTableCreator((tableName) => `web_${tableName}`),
}
