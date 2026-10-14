import { and, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm"
import { ENDED_MODERATION_RETENTION_DAYS } from "@/constants"
import { AUDIT_TYPE, auditLog, type TAuditType } from "@/db/schema/tg/audit-log"

// Moderation records are kept only while the measure is in force (privacy policy, data retention):
// temporary measures until they expire, permanent ones until they are revoked.

/** The measures each revocation lifts; `allGroups` when it lifts them in every group. */
const REVOKES: Partial<Record<TAuditType, { types: TAuditType[]; allGroups: boolean }>> = {
  [AUDIT_TYPE.UNBAN]: { types: [AUDIT_TYPE.BAN], allGroups: false },
  [AUDIT_TYPE.UNMUTE]: { types: [AUDIT_TYPE.MUTE], allGroups: false },
  // The bot's unban_all unbans the target in every group, which also lifts single-group bans.
  [AUDIT_TYPE.UNBAN_ALL]: { types: [AUDIT_TYPE.BAN_ALL, AUDIT_TYPE.BAN], allGroups: true },
}

/** Records that are not a measure in force: a kick ends at once, a revocation only lifts one. */
const NOT_IN_FORCE: TAuditType[] = [AUDIT_TYPE.KICK, AUDIT_TYPE.UNBAN, AUDIT_TYPE.UNMUTE, AUDIT_TYPE.UNBAN_ALL]

/**
 * The records of the measures `revocation` lifts, or undefined when it is not a revocation. Only
 * records stored before the revocation match, so it never lifts a later measure.
 */
export function revokedMeasures(revocation: {
  id: number
  type: TAuditType
  targetId: number
  groupId: number | null
}): SQL | undefined {
  const revokes = REVOKES[revocation.type]
  if (!revokes) return undefined

  const group = revokes.allGroups
    ? undefined
    : revocation.groupId === null
      ? isNull(auditLog.groupId)
      : eq(auditLog.groupId, revocation.groupId)
  return and(
    eq(auditLog.targetId, revocation.targetId),
    inArray(auditLog.type, revokes.types),
    lt(auditLog.id, revocation.id),
    group
  )
}

/**
 * Records with nothing left in force at `now`: temporary bans and mutes past their end, and kicks
 * and revocations. The latter are kept for {@link ENDED_MODERATION_RETENTION_DAYS}, long enough
 * for the bot's retries of a revocation to hit its idempotency key instead of lifting a later
 * measure.
 */
export function endedMeasures(now: Date): SQL | undefined {
  const notInForceSince = new Date(now)
  notInForceSince.setDate(notInForceSince.getDate() - ENDED_MODERATION_RETENTION_DAYS)

  return or(
    and(inArray(auditLog.type, [AUDIT_TYPE.BAN, AUDIT_TYPE.MUTE]), lt(auditLog.until, now)),
    and(inArray(auditLog.type, NOT_IN_FORCE), lt(auditLog.createdAt, notInForceSince))
  )
}
