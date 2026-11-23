import type { BunSQLDatabase } from "drizzle-orm/bun-sql"
import type { schema } from "@/db/schema"

/** The backend's database, as the regulations modules use it (the backend's `DB`, or the collab service's own). */
export type RegulationsDb = BunSQLDatabase<typeof schema>
export type RegulationsTx = Parameters<Parameters<RegulationsDb["transaction"]>[0]>[0]

/** SHA-256 hex of bytes, for content-addressed blobs. */
export function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex")
}
