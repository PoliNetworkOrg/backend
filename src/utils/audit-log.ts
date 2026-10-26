import { and, eq, inArray, isNotNull, isNull, lt, notExists, or, type SQL, sql } from "drizzle-orm"
import { type AnyPgColumn, alias, QueryBuilder } from "drizzle-orm/pg-core"
import { ENDED_MODERATION_RETENTION_DAYS, MODERATION_RETENTION_MONTHS } from "@/constants"
import { AUDIT_TYPE, auditLog, type TAuditType } from "@/db/schema/tg/audit-log"

// Moderation records are kept for 24 months after expiry if temporary, until revocation if
// permanent (privacy policy, data retention). A kick is a temporary measure that ends at once.

/** The measures each revocation lifts; `allGroups` when it lifts them in every group. */
const REVOKES: Partial<Record<TAuditType, { types: TAuditType[]; allGroups: boolean }>> = {
  [AUDIT_TYPE.UNBAN]: { types: [AUDIT_TYPE.BAN], allGroups: false },
  [AUDIT_TYPE.UNMUTE]: { types: [AUDIT_TYPE.MUTE], allGroups: false },
  // The bot's unban_all unbans the target in every group, which also lifts single-group bans.
  [AUDIT_TYPE.UNBAN_ALL]: { types: [AUDIT_TYPE.BAN_ALL, AUDIT_TYPE.BAN], allGroups: true },
}

const MEASURES: TAuditType[] = [AUDIT_TYPE.BAN, AUDIT_TYPE.MUTE, AUDIT_TYPE.BAN_ALL]
const REVOCATIONS: TAuditType[] = [AUDIT_TYPE.UNBAN, AUDIT_TYPE.UNMUTE, AUDIT_TYPE.UNBAN_ALL]

/** Telegram treats a restriction ending more than 366 days after it is applied as permanent. */
const TELEGRAM_FOREVER_AFTER = sql.raw(`interval '366 days'`)

type MeasureRecord = { until: AnyPgColumn; createdAt: AnyPgColumn }

/** A measure with an end date Telegram honours. */
function temporary(record: MeasureRecord) {
  return and(isNotNull(record.until), sql`${record.until} <= ${record.createdAt} + ${TELEGRAM_FOREVER_AFTER}`)
}

/** A measure without an end date, or with one Telegram ignores. */
function permanent(record: MeasureRecord) {
  return or(isNull(record.until), sql`${record.until} > ${record.createdAt} + ${TELEGRAM_FOREVER_AFTER}`)
}

/**
 * The records `revocation` deletes, or undefined when it is not a revocation: the permanent
 * measures it lifts. Lifted temporary measures stay until their retention ends. Only records
 * stored before the revocation match, so it never lifts a later measure.
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
    group,
    permanent(auditLog)
  )
}

/** Whether the revocation in the outer `auditLog` row lifted a temporary measure still in force. */
function liftsTemporaryMeasure() {
  const lifted = alias(auditLog, "lifted")
  const revokes = Object.entries(REVOKES).map(([type, { types, allGroups }]) =>
    and(
      eq(auditLog.type, type as TAuditType),
      inArray(lifted.type, types),
      allGroups ? undefined : sql`${lifted.groupId} is not distinct from ${auditLog.groupId}`
    )
  )
  return new QueryBuilder()
    .select({ one: sql`1` })
    .from(lifted)
    .where(
      and(
        eq(lifted.targetId, auditLog.targetId),
        lt(lifted.id, auditLog.id),
        or(...revokes),
        temporary(lifted),
        sql`${lifted.until} > ${auditLog.createdAt}`
      )
    )
}

/**
 * Records past their retention at `now`:
 * - temporary measures {@link MODERATION_RETENTION_MONTHS} after they end, kicks the same time
 *   after they are made;
 * - revocations of a temporary measure as long as a temporary measure, from when they are made;
 * - other revocations after {@link ENDED_MODERATION_RETENTION_DAYS}, long enough for the bot's
 *   retries of a revocation to hit its idempotency key instead of lifting a later measure.
 *
 * Permanent measures are deleted only by their revocation, see {@link revokedMeasures}.
 */
export function endedMeasures(now: Date): SQL | undefined {
  const retainedSince = new Date(now)
  retainedSince.setUTCMonth(retainedSince.getUTCMonth() - MODERATION_RETENTION_MONTHS)
  const retriesSince = new Date(now)
  retriesSince.setDate(retriesSince.getDate() - ENDED_MODERATION_RETENTION_DAYS)

  return or(
    and(inArray(auditLog.type, MEASURES), temporary(auditLog), lt(auditLog.until, retainedSince)),
    and(inArray(auditLog.type, [AUDIT_TYPE.KICK, ...REVOCATIONS]), lt(auditLog.createdAt, retainedSince)),
    and(inArray(auditLog.type, REVOCATIONS), lt(auditLog.createdAt, retriesSince), notExists(liftsTemporaryMeasure()))
  )
}
