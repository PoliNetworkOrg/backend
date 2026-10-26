import { and, gt, inArray, isNull, lte } from "drizzle-orm"
import { DB, SCHEMA } from "@/db"

const GRANTS = SCHEMA.TG.grants

/** A grant, made by an IdP subject (RFC v3 §9.3). */
export type Grant = {
  /** @deprecated Always `idp:<id>`; kept for dashboards built against SDK v2. Use `id`. */
  key: string
  id: number
  /** @deprecated Always `"idp"`: the legacy grants table was dropped in Phase 6. */
  source: "idp"
  userId: number
  /** @deprecated Always null: grants are made by IdP subjects. Use `grantedBySub`. */
  grantedBy: null
  grantedBySub: string
  validSince: Date
  validUntil: Date
  reason: string | null
  createdAt: Date
  updatedAt: Date | null
}

/** Which grants to list; both exclude interrupted ones. */
export type GrantWindow =
  /** `valid_since ≤ now < valid_until` (RFC v3 §9.3). */
  | "active"
  /** Not started yet. */
  | "scheduled"

export async function listGrants(
  window: GrantWindow,
  options: { userIds?: number[]; now?: Date } = {}
): Promise<Grant[]> {
  const now = options.now ?? new Date()
  const { userIds } = options
  if (userIds?.length === 0) return []

  const rows = await DB.select()
    .from(GRANTS)
    .where(
      and(
        window === "active" ? and(lte(GRANTS.validSince, now), gt(GRANTS.validUntil, now)) : gt(GRANTS.validSince, now),
        isNull(GRANTS.interruptedAt),
        userIds ? inArray(GRANTS.telegramUserId, userIds) : undefined
      )
    )

  return rows.map(
    (row): Grant => ({
      key: `idp:${row.id}`,
      id: row.id,
      source: "idp",
      userId: row.telegramUserId,
      grantedBy: null,
      grantedBySub: row.grantedBySub,
      validSince: row.validSince,
      validUntil: row.validUntil,
      reason: row.reason,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
  )
}

/** Each user's active grant that lasts longest, if any. */
export async function activeGrantByUser(userIds: number[], now = new Date()): Promise<Map<number, Grant>> {
  const result = new Map<number, Grant>()
  for (const grant of await listGrants("active", { userIds, now })) {
    const best = result.get(grant.userId)
    if (!best || grant.validUntil > best.validUntil) result.set(grant.userId, grant)
  }
  return result
}
