import { PoolConfig } from "pg";

export function makeConnection(dbName: string): PoolConfig {
  return {
    database: dbName,
    host: process.env.DB_HOST!,
    port: parseInt(process.env.DB_PORT!),
    user: process.env.DB_USER!,
    password: process.env.DB_PASS!,
    ssl: false,
  } as PoolConfig;
}
