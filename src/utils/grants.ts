import { and, gt, inArray, isNull, lte, type SQL } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"
import { DB, SCHEMA } from "@/db"

const LEGACY = SCHEMA.TG.grants
const GRANTS = SCHEMA.TG.grantsV2

/**
 * A grant from either table. Legacy grants were made by Telegram ID (`grantedBy`), new ones by
 * IdP subject (`grantedBySub`). Ids are unique only within a `source`; `key` is unique overall.
 */
export type Grant = {
  key: string
  id: number
  source: "legacy" | "idp"
  userId: number
  grantedBy: number | null
  grantedBySub: string | null
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

function windowOf(columns: { validSince: PgColumn; validUntil: PgColumn }) {
  return (window: GrantWindow, now: Date): SQL | undefined => {
    if (window === "active") return and(lte(columns.validSince, now), gt(columns.validUntil, now))
    return gt(columns.validSince, now)
  }
}

/**
 * Grants from the legacy table and the new one, until the legacy table is dropped in Phase 6. A
 * legacy grant interrupted by either path is excluded; who interrupted never matters.
 */
export async function listGrants(
  window: GrantWindow,
  options: { userIds?: number[]; now?: Date } = {}
): Promise<Grant[]> {
  const now = options.now ?? new Date()
  const { userIds } = options
  if (userIds?.length === 0) return []

  const [legacy, current] = await Promise.all([
    DB.select()
      .from(LEGACY)
      .where(
        and(
          windowOf(LEGACY)(window, now),
          isNull(LEGACY.interruptedBy),
          isNull(LEGACY.interruptedAt),
          userIds ? inArray(LEGACY.userId, userIds) : undefined
        )
      ),
    DB.select()
      .from(GRANTS)
      .where(
        and(
          windowOf(GRANTS)(window, now),
          isNull(GRANTS.interruptedAt),
          userIds ? inArray(GRANTS.telegramUserId, userIds) : undefined
        )
      ),
  ])

  return [
    ...legacy.map(
      (row): Grant => ({
        key: `legacy:${row.id}`,
        id: row.id,
        source: "legacy",
        userId: row.userId,
        grantedBy: row.grantedBy,
        grantedBySub: null,
        validSince: row.validSince,
        validUntil: row.validUntil,
        reason: row.reason,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })
    ),
    ...current.map(
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
    ),
  ]
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
