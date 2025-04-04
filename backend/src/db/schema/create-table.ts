import { pgTableCreator } from "drizzle-orm/pg-core";

export const createTable = {
  tg: pgTableCreator((tableName) => `tg_${tableName}`),
  web: pgTableCreator((tableName) => `web_${tableName}`),
};
