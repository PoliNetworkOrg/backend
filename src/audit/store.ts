import { DB, SCHEMA } from "@/db"
import type { AuditEvent } from "."

/** Kept apart from `src/audit` so that importing the tRPC setup does not open the database. */
export async function writeAuditEvent(event: AuditEvent) {
  await DB.insert(SCHEMA.COMMON.auditEvents).values(event)
}
