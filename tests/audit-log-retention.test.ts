import { PgDialect } from "drizzle-orm/pg-core"
import { describe, expect, it } from "vitest"
import { endedMeasures, revokedMeasures } from "@/utils/audit-log"

const dialect = new PgDialect()
function render(condition: Parameters<PgDialect["sqlToQuery"]>[0] | undefined) {
  if (!condition) return undefined
  const { sql, params } = dialect.sqlToQuery(condition)
  return { sql, params }
}

describe("revokedMeasures", () => {
  it("matches the earlier bans of the target in the same group on unban", () => {
    expect(render(revokedMeasures({ id: 9, type: "unban", targetId: 777, groupId: -100 }))).toEqual({
      sql: '("tg_audit_log"."target_id" = $1 and "tg_audit_log"."type" in ($2) and "tg_audit_log"."id" < $3 and "tg_audit_log"."group_id" = $4)',
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

  it("matches ban_all and the bans in every group on unban_all", () => {
    expect(render(revokedMeasures({ id: 9, type: "unban_all", targetId: 777, groupId: null }))).toEqual({
      sql: '("tg_audit_log"."target_id" = $1 and "tg_audit_log"."type" in ($2, $3) and "tg_audit_log"."id" < $4)',
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
  it("matches expired temporary measures, and kicks and revocations older than a day", () => {
    const now = new Date("2026-10-14T12:00:00Z")
    expect(render(endedMeasures(now))).toEqual({
      sql: '(("tg_audit_log"."type" in ($1, $2) and "tg_audit_log"."until" < $3) or ("tg_audit_log"."type" in ($4, $5, $6, $7) and "tg_audit_log"."created_at" < $8))',
      params: [
        "ban",
        "mute",
        now.toISOString(),
        "kick",
        "unban",
        "unmute",
        "unban_all",
        new Date("2026-10-13T12:00:00Z").toISOString(),
      ],
    })
  })
})
