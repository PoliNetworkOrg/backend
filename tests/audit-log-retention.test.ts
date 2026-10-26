import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { endedMeasures, revokedMeasures } from "@/utils/audit-log"

const dialect = new PgDialect()
function render(condition: Parameters<PgDialect["sqlToQuery"]>[0] | undefined) {
  if (!condition) return undefined
  const { sql, params } = dialect.sqlToQuery(condition)
  return { sql, params }
}

/** No end date, or one Telegram treats as forever. */
const PERMANENT =
  '("tg_audit_log"."until" is null or "tg_audit_log"."until" > "tg_audit_log"."created_at" + interval \'366 days\')'
/** An end date Telegram honours. */
const TEMPORARY = (table: string) =>
  `("${table}"."until" is not null and "${table}"."until" <= "${table}"."created_at" + interval '366 days')`

describe("revokedMeasures", () => {
  it("matches the earlier permanent bans of the target in the same group on unban", () => {
    expect(render(revokedMeasures({ id: 9, type: "unban", targetId: 777, groupId: -100 }))).toEqual({
      sql: `("tg_audit_log"."target_id" = $1 and "tg_audit_log"."type" in ($2) and "tg_audit_log"."id" < $3 and "tg_audit_log"."group_id" = $4 and ${PERMANENT})`,
      params: [777, "ban", 9, -100],
    })
  })

  it("matches the earlier mutes of the target in the same group on unmute", () => {
    expect(render(revokedMeasures({ id: 9, type: "unmute", targetId: 777, groupId: -100 }))?.params).toEqual([
      777,
      "mute",
      9,
      -100,
    ])
  })

  it("matches the permanent ban_all and bans in every group on unban_all", () => {
    expect(render(revokedMeasures({ id: 9, type: "unban_all", targetId: 777, groupId: null }))).toEqual({
      sql: `("tg_audit_log"."target_id" = $1 and "tg_audit_log"."type" in ($2, $3) and "tg_audit_log"."id" < $4 and ${PERMANENT})`,
      params: [777, "ban_all", "ban", 9],
    })
  })

  it("matches nothing for a measure", () => {
    for (const type of ["ban", "mute", "kick", "ban_all"] as const) {
      expect(revokedMeasures({ id: 9, type, targetId: 777, groupId: -100 })).toBeUndefined()
    }
  })
})

describe("endedMeasures", () => {
  const now = new Date("2026-10-14T12:00:00Z")
  const twoYearsAgo = new Date("2024-10-14T12:00:00Z").toISOString()
  const yesterday = new Date("2026-10-13T12:00:00Z").toISOString()
  const ended = render(endedMeasures(now))

  it("matches temporary measures 24 months after they end", () => {
    expect(ended?.sql).toContain(
      `("tg_audit_log"."type" in ($1, $2, $3) and ${TEMPORARY("tg_audit_log")} and "tg_audit_log"."until" < $4)`
    )
    expect(ended?.params.slice(0, 4)).toEqual(["ban", "mute", "ban_all", twoYearsAgo])
  })

  it("matches kicks and revocations 24 months after they are made", () => {
    expect(ended?.sql).toContain('("tg_audit_log"."type" in ($5, $6, $7, $8) and "tg_audit_log"."created_at" < $9)')
    expect(ended?.params.slice(4, 9)).toEqual(["kick", "unban", "unmute", "unban_all", twoYearsAgo])
  })

  it("matches revocations older than a day that lifted no temporary measure in force", () => {
    expect(ended?.sql).toContain(
      '("tg_audit_log"."type" in ($10, $11, $12) and "tg_audit_log"."created_at" < $13 and not exists (select 1 from "tg_audit_log" "lifted" where ('
    )
    expect(ended?.sql).toContain(
      '"lifted"."target_id" = "tg_audit_log"."target_id" and "lifted"."id" < "tg_audit_log"."id" and ' +
        '(("tg_audit_log"."type" = $14 and "lifted"."type" in ($15) and "lifted"."group_id" is not distinct from "tg_audit_log"."group_id") or ' +
        '("tg_audit_log"."type" = $16 and "lifted"."type" in ($17) and "lifted"."group_id" is not distinct from "tg_audit_log"."group_id") or ' +
        '("tg_audit_log"."type" = $18 and "lifted"."type" in ($19, $20))) and ' +
        `${TEMPORARY("lifted")} and "lifted"."until" > "tg_audit_log"."created_at"`
    )
    expect(ended?.params.slice(9)).toEqual([
      "unban",
      "unmute",
      "unban_all",
      yesterday,
      "unban",
      "ban",
      "unmute",
      "mute",
      "unban_all",
      "ban_all",
      "ban",
    ])
  })

  it("never matches a permanent measure", () => {
    expect(ended?.sql).not.toContain('"tg_audit_log"."until" is null')
  })
})
