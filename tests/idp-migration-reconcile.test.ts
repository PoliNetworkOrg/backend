import { describe, expect, it } from "vitest"
import {
  type AccessSnapshot,
  accessSnapshotSchema,
  EXPORT_SCHEMA,
  formatReport,
  LEGACY_CHECKS,
  type LegacyExport,
  legacyAllows,
  legacyExportSchema,
  reconcile,
} from "../scripts/lib/legacy-access"

const at = new Date("2026-10-10T12:00:00Z")

function holder(telegramId: string, roles: string[], username: string | null = null) {
  return {
    telegramId,
    username,
    roles,
    addedBy: "1",
    modifiedBy: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: null,
  }
}

function legacyExport(holders: LegacyExport["holders"], groupAdmins: LegacyExport["groupAdmins"] = []) {
  return legacyExportSchema.parse({
    schema: EXPORT_SCHEMA,
    exportedAt: "2026-10-10T00:00:00.000Z",
    holders,
    groupAdmins,
  })
}

function snapshot(subjects: AccessSnapshot["subjects"], sources: AccessSnapshot["sources"] = {}) {
  return accessSnapshotSchema.parse({
    schema: "polinetwork.access-snapshot/v1",
    projection: "backend",
    generation: 7,
    builtAt: "2026-10-10T11:59:00Z",
    sources: { rbac: { health: "ok", observedAt: "2026-10-10T11:59:00Z" }, ...sources },
    subjects,
  })
}

const permanent = (...keys: string[]) => Object.fromEntries(keys.map((key) => [key, { validUntil: null }]))
function check(id: string) {
  const found = LEGACY_CHECKS.find((entry) => entry.id === id)
  if (!found) throw new Error(`Unknown check ${id}`)
  return found
}

describe("legacy role rules", () => {
  it("reproduces today's role checks, including the creator deny rule", () => {
    expect(legacyAllows(check("bot.moderate").rule, ["owner"])).toBe(true)
    expect(legacyAllows(check("bot.moderate").rule, ["owner", "creator"])).toBe(false)
    expect(legacyAllows(check("bot.moderate").rule, ["president"])).toBe(false)
    expect(legacyAllows(check("backend.add-bot").rule, ["creator"])).toBe(true)
    expect(legacyAllows(check("dashboard.access").rule, ["admin"])).toBe(false)
    expect(legacyAllows(check("dashboard.web-content").rule, ["web"])).toBe(true)
    expect(legacyAllows(check("bot.trusted").rule, ["admin"])).toBe(true)
    expect(legacyAllows(check("bot.trusted").rule, [])).toBe(false)
  })
})

describe("reconcile", () => {
  it("matches a linked holder whose IdP permissions reproduce the legacy decisions", () => {
    const roles = ["admin"]
    const expected = LEGACY_CHECKS.filter((entry) => legacyAllows(entry.rule, roles)).map((entry) => entry.permission)
    const report = reconcile(
      legacyExport([holder("100", roles)]),
      snapshot([{ sub: "usr_a", telegramId: "100", permissions: permanent(...expected) }]),
      at
    )
    expect(report.holders[0].sub).toBe("usr_a")
    expect(report.holders[0].checks.every((entry) => entry.status === "match")).toBe(true)
  })

  it("reports missing and extra access rule by rule", () => {
    const report = reconcile(
      legacyExport([holder("100", ["direttivo"])]),
      snapshot([{ sub: "usr_a", telegramId: "100", permissions: permanent("tg:moderate", "azure:members:create") }]),
      at
    )
    const statuses = Object.fromEntries(report.holders[0].checks.map((entry) => [entry.id, entry.status]))
    expect(statuses["bot.moderate"]).toBe("match")
    expect(statuses["bot.pin"]).toBe("missing")
    expect(statuses["bot.grants-menu"]).toBe("missing")
    expect(statuses["dashboard.azure"]).toBe("match")
    expect(report.holders[0].checks.some((entry) => entry.status === "extra")).toBe(false)

    const extra = reconcile(
      legacyExport([holder("200", ["hr"])]),
      snapshot([{ sub: "usr_b", telegramId: "200", permissions: permanent("tg:moderate") }]),
      at
    )
    expect(extra.holders[0].checks.find((entry) => entry.id === "bot.moderate")?.status).toBe("extra")
  })

  it("treats expired permissions as not held and unlinked holders as holding nothing", () => {
    const report = reconcile(
      legacyExport([holder("100", ["owner"]), holder("300", ["hr"], "hr_person")]),
      snapshot([
        {
          sub: "usr_a",
          telegramId: "100",
          permissions: { "tg:moderate": { validUntil: "2026-10-10T11:00:00Z" } },
        },
      ]),
      at
    )
    expect(report.holders[0].checks.find((entry) => entry.id === "bot.moderate")).toMatchObject({
      legacy: true,
      idp: false,
      status: "missing",
    })
    expect(report.holders[1]).toMatchObject({ telegramId: "300", sub: null })
    expect(report.holders[1].checks.some((entry) => entry.idp)).toBe(false)
  })

  it("lists IdP subjects with checked permissions who hold no legacy role", () => {
    const report = reconcile(
      legacyExport([holder("100", ["owner"])]),
      snapshot([
        { sub: "usr_new", telegramId: "400", permissions: permanent("tg:moderate", "membership:read") },
        { sub: "usr_web", telegramId: null, permissions: permanent("admin:access") },
        { sub: "usr_student", telegramId: "500", permissions: permanent("student:verified") },
      ]),
      at
    )
    expect(report.notLegacyHolders).toEqual([
      { sub: "usr_new", telegramId: "400", permissions: ["tg:moderate"] },
      { sub: "usr_web", telegramId: null, permissions: ["admin:access"] },
    ])
  })

  it("refuses a snapshot that links one Telegram ID to two subjects", () => {
    expect(() =>
      reconcile(
        legacyExport([]),
        snapshot([
          { sub: "usr_a", telegramId: "100", permissions: {} },
          { sub: "usr_b", telegramId: "100", permissions: {} },
        ]),
        at
      )
    ).toThrow(/more than one IdP subject/)
  })

  it("rejects an unknown snapshot major version", () => {
    expect(() =>
      accessSnapshotSchema.parse({
        schema: "polinetwork.access-snapshot/v2",
        projection: "backend",
        generation: 1,
        builtAt: "2026-10-10T11:59:00Z",
        sources: {},
        subjects: [],
      })
    ).toThrow()
  })

  it("formats unlinked holders, differences and unhealthy sources", () => {
    const report = reconcile(
      legacyExport(
        [holder("100", ["owner"], "owner_person"), holder("300", ["hr"])],
        [
          {
            telegramId: "300",
            username: null,
            groupId: "-1001",
            groupTitle: "Group",
            addedBy: "1",
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ]
      ),
      snapshot([{ sub: "usr_a", telegramId: "100", permissions: permanent("tg:moderate") }], {
        "entra:soci": { health: "degraded", observedAt: "2026-10-10T11:00:00Z", error: "graph_timeout" },
      }),
      at
    )
    const text = formatReport(report)
    expect(text).toContain("entra:soci (degraded: graph_timeout)")
    expect(text).toContain("- 300: hr")
    expect(text).toContain("### @owner_person (100)")
    expect(text).toContain("| bot.pin | `tg:messages:pin` | yes | no | loses access |")
    expect(text).toContain("1 people, 1 assignments")
  })
})
