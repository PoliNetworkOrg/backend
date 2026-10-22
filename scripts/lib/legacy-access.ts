import { z } from "zod"

/**
 * IdP–Telegram migration, Phase 2 (RFC v3 §13): compare what the legacy Telegram roles allow
 * today with what the IdP access snapshot grants, for every legacy role holder.
 *
 * Each check reproduces one role rule as it is enforced today, and names the permission that
 * replaces it (RFC §4.1, §8, §10.2). Some permissions replace several legacy rules that do not
 * agree with each other, so the report compares rule by rule rather than permission by
 * permission. Keep these rules in sync with the callers until they are switched to the IdP.
 */
type LegacyRule = { anyOf: readonly string[] | "any"; deny?: readonly string[] }

export type LegacyCheck = {
  id: string
  description: string
  permission: string
  rule: LegacyRule
}

const DASHBOARD_READ: LegacyRule = { anyOf: ["owner", "direttivo", "president", "hr", "web"], deny: ["creator"] }
const DASHBOARD_WRITE: LegacyRule = { anyOf: ["owner", "direttivo", "president"], deny: ["creator"] }
const DASHBOARD_WEB_WRITE: LegacyRule = { anyOf: ["owner", "direttivo", "president", "web"], deny: ["creator"] }

export const LEGACY_CHECKS: readonly LegacyCheck[] = [
  {
    id: "dashboard.access",
    description: "Sign in to the admin dashboard (admin: hasAdminRole)",
    permission: "admin:access",
    rule: DASHBOARD_READ,
  },
  {
    id: "bot.moderate",
    description: "/ban /tban /unban /kick /mute /tmute /unmute (telegram: commands/moderation)",
    permission: "tg:moderate",
    rule: { anyOf: ["owner", "direttivo"], deny: ["creator"] },
  },
  {
    id: "bot.ban-all",
    description: "/ban_all /unban_all (telegram: commands/moderation/banall.ts)",
    permission: "tg:moderate:global",
    rule: { anyOf: ["owner", "direttivo"] },
  },
  {
    id: "bot.campaign-review",
    description: "Campaign review Confirm/Release (telegram: CAMPAIGN_REVIEW_ROLES)",
    permission: "tg:moderate:global",
    rule: { anyOf: ["owner", "direttivo"] },
  },
  {
    id: "bot.delete",
    description: "/del (telegram: commands/moderation/del.ts)",
    permission: "tg:messages:delete",
    rule: { anyOf: ["admin", "owner", "direttivo"] },
  },
  {
    id: "bot.pin",
    description: "/pin /unpin (telegram: commands/pin.ts)",
    permission: "tg:messages:pin",
    rule: { anyOf: ["direttivo", "owner"] },
  },
  {
    id: "bot.immune",
    description: "Ban-all immunity and campaign-spam exemption (telegram: BYPASS_ROLES, NETWORK_PRIVILEGED_ROLES)",
    permission: "tg:immune",
    rule: { anyOf: ["president", "owner", "direttivo"] },
  },
  {
    id: "bot.trusted",
    description: "Hashtag-rule exemption: holds any role (telegram: group-specific-actions.ts)",
    permission: "tg:trusted",
    rule: { anyOf: "any" },
  },
  {
    id: "bot.audit",
    description: "/audit (telegram: commands/management/audit.ts)",
    permission: "tg:audit:read",
    rule: { anyOf: ["hr", "owner", "direttivo"] },
  },
  {
    id: "dashboard.telegram-users",
    description: "Telegram user list and details in the dashboard",
    permission: "tg:users:read",
    rule: DASHBOARD_READ,
  },
  {
    id: "dashboard.telegram-messages",
    description: "Stored Telegram messages in the dashboard",
    permission: "tg:messages:read",
    rule: DASHBOARD_READ,
  },
  {
    id: "bot.groups",
    description: "/updategroup /regenerate_group_links (telegram: commands/management/groups.ts)",
    permission: "tg:groups:manage",
    rule: { anyOf: ["owner", "direttivo"] },
  },
  {
    id: "dashboard.telegram-groups",
    description: "Hide or leave a Telegram group in the dashboard (admin: hasGroupWriteRole)",
    permission: "tg:groups:manage",
    rule: DASHBOARD_WEB_WRITE,
  },
  {
    id: "backend.add-bot",
    description: "Add the bot to a group (backend: CAN_ADD_BOT)",
    permission: "tg:bot:add",
    rule: { anyOf: ["hr", "owner", "creator", "direttivo"] },
  },
  {
    id: "dashboard.grants-read",
    description: "View grants in the dashboard",
    permission: "tg:grants:read",
    rule: DASHBOARD_READ,
  },
  {
    id: "backend.grants-manage",
    description: "Create and interrupt grants (backend: CAN_MANAGE_GRANTS)",
    permission: "tg:grants:manage",
    rule: { anyOf: ["president", "owner", "direttivo"] },
  },
  {
    id: "bot.grants-menu",
    description: "Delete a granted user's message from the grants log (telegram: tg-logger/grants.ts)",
    permission: "tg:grants:manage",
    rule: { anyOf: ["direttivo"] },
  },
  {
    id: "dashboard.whatsapp-groups",
    description: "WhatsApp group CRUD in the dashboard (admin: hasGroupWriteRole)",
    permission: "wa:groups:manage",
    rule: DASHBOARD_WEB_WRITE,
  },
  {
    id: "dashboard.group-labels",
    description: "Group labels and tagging in the dashboard (admin: hasWebWriteRole)",
    permission: "groups:labels:write",
    rule: DASHBOARD_WEB_WRITE,
  },
  {
    id: "dashboard.web-content",
    description: "Associations, FAQs, projects and freshman guides (admin: hasWebWriteRole)",
    permission: "web:content:write",
    rule: DASHBOARD_WEB_WRITE,
  },
  {
    id: "dashboard.group-link-reports",
    description: "Resolve or dismiss group-link reports (admin: hasWebWriteRole)",
    permission: "web:reports:manage",
    rule: DASHBOARD_WEB_WRITE,
  },
  {
    id: "dashboard.azure",
    description: "Azure member management; becomes creating a socio only (admin: hasWriteAdminRole)",
    permission: "azure:members:create",
    rule: DASHBOARD_WRITE,
  },
]

export const CHECKED_PERMISSIONS: readonly string[] = [...new Set(LEGACY_CHECKS.map((check) => check.permission))]

export function legacyAllows(rule: LegacyRule, roles: readonly string[]) {
  if (rule.deny?.some((role) => roles.includes(role))) return false
  return rule.anyOf === "any" ? roles.length > 0 : rule.anyOf.some((role) => roles.includes(role))
}

const telegramId = z.string().regex(/^-?\d+$/)
const timestamp = z.iso.datetime({ offset: true })

export const EXPORT_SCHEMA = "polinetwork.legacy-access-export/v1"

export const legacyExportSchema = z.object({
  schema: z.literal(EXPORT_SCHEMA),
  exportedAt: timestamp,
  holders: z.array(
    z.object({
      telegramId,
      username: z.string().nullable(),
      roles: z.array(z.string()),
      addedBy: telegramId,
      modifiedBy: telegramId.nullable(),
      createdAt: timestamp,
      updatedAt: timestamp.nullable(),
    })
  ),
  groupAdmins: z.array(
    z.object({
      telegramId,
      username: z.string().nullable(),
      groupId: telegramId,
      groupTitle: z.string().nullable(),
      addedBy: telegramId,
      createdAt: timestamp,
    })
  ),
})

export type LegacyExport = z.infer<typeof legacyExportSchema>

export const accessSnapshotSchema = z.object({
  // A consumer rejects a major version it does not know (RFC §5.3).
  schema: z.string().regex(/^polinetwork\.access-snapshot\/v1(\.\d+)*$/),
  projection: z.string(),
  generation: z.number(),
  builtAt: timestamp,
  sources: z.record(
    z.string(),
    z.object({ health: z.string(), observedAt: timestamp.nullable().optional(), error: z.string().optional() })
  ),
  subjects: z.array(
    z.object({
      sub: z.string(),
      telegramId: telegramId.nullable(),
      permissions: z.record(z.string(), z.object({ validUntil: timestamp.nullable() })),
    })
  ),
})

export type AccessSnapshot = z.infer<typeof accessSnapshotSchema>

export type CheckStatus = "match" | "missing" | "extra"

export type HolderReport = {
  telegramId: string
  username: string | null
  roles: string[]
  /** The IdP subject linked to this Telegram ID, or null if they have not linked it yet. */
  sub: string | null
  checks: { id: string; permission: string; legacy: boolean; idp: boolean; status: CheckStatus }[]
}

export type ReconciliationReport = {
  at: string
  snapshot: { generation: number; builtAt: string; unhealthySources: string[] }
  holders: HolderReport[]
  /** IdP subjects holding a checked permission who hold no legacy role. */
  notLegacyHolders: { sub: string; telegramId: string | null; permissions: string[] }[]
  groupAdmins: { people: number; assignments: number }
}

function heldAt(permissions: AccessSnapshot["subjects"][number]["permissions"], key: string, at: Date) {
  const entry = permissions[key]
  return !!entry && (entry.validUntil === null || new Date(entry.validUntil) > at)
}

export function reconcile(legacy: LegacyExport, snapshot: AccessSnapshot, at = new Date()): ReconciliationReport {
  const byTelegramId = new Map<string, AccessSnapshot["subjects"][number]>()
  for (const subject of snapshot.subjects) {
    if (subject.telegramId === null) continue
    // The IdP excludes duplicated Telegram IDs (RFC §7.6); refuse a snapshot that does not.
    if (byTelegramId.has(subject.telegramId))
      throw new Error(`Telegram ID ${subject.telegramId} is linked to more than one IdP subject`)
    byTelegramId.set(subject.telegramId, subject)
  }

  const holders = legacy.holders
    .map((holder): HolderReport => {
      const subject = byTelegramId.get(holder.telegramId)
      return {
        telegramId: holder.telegramId,
        username: holder.username,
        roles: [...holder.roles].sort(),
        sub: subject?.sub ?? null,
        checks: LEGACY_CHECKS.map((check) => {
          const allowed = legacyAllows(check.rule, holder.roles)
          const granted = subject ? heldAt(subject.permissions, check.permission, at) : false
          const status: CheckStatus = allowed === granted ? "match" : allowed ? "missing" : "extra"
          return { id: check.id, permission: check.permission, legacy: allowed, idp: granted, status }
        }),
      }
    })
    .sort((a, b) => a.telegramId.localeCompare(b.telegramId))

  const legacyIds = new Set(legacy.holders.map((holder) => holder.telegramId))
  const notLegacyHolders = snapshot.subjects
    .filter((subject) => subject.telegramId === null || !legacyIds.has(subject.telegramId))
    .map((subject) => ({
      sub: subject.sub,
      telegramId: subject.telegramId,
      permissions: CHECKED_PERMISSIONS.filter((key) => heldAt(subject.permissions, key, at)),
    }))
    .filter((subject) => subject.permissions.length > 0)
    .sort((a, b) => a.sub.localeCompare(b.sub))

  return {
    at: at.toISOString(),
    snapshot: {
      generation: snapshot.generation,
      builtAt: snapshot.builtAt,
      unhealthySources: Object.entries(snapshot.sources)
        .filter(([, source]) => source.health !== "ok")
        .map(([name, source]) => `${name} (${source.health}${source.error ? `: ${source.error}` : ""})`),
    },
    holders,
    notLegacyHolders,
    groupAdmins: {
      people: new Set(legacy.groupAdmins.map((entry) => entry.telegramId)).size,
      assignments: legacy.groupAdmins.length,
    },
  }
}

function person(holder: { telegramId: string | null; username: string | null }) {
  return holder.username ? `@${holder.username} (${holder.telegramId})` : (holder.telegramId ?? "no Telegram link")
}

export function formatReport(report: ReconciliationReport) {
  const unlinked = report.holders.filter((holder) => holder.sub === null)
  const differing = report.holders.filter(
    (holder) => holder.sub !== null && holder.checks.some((check) => check.status !== "match")
  )
  const lines = [
    "# IdP–Telegram migration: reconciliation report",
    "",
    `Evaluated at ${report.at} against snapshot generation ${report.snapshot.generation} built at ${report.snapshot.builtAt}.`,
  ]
  if (report.snapshot.unhealthySources.length > 0)
    lines.push("", `**Unhealthy snapshot sources:** ${report.snapshot.unhealthySources.join(", ")}.`)
  lines.push(
    "",
    `- Legacy role holders: ${report.holders.length}`,
    `- Not linked in the IdP yet: ${unlinked.length}`,
    `- Linked with differences: ${differing.length}`,
    `- Linked and matching: ${report.holders.length - unlinked.length - differing.length}`,
    `- IdP subjects with checked permissions and no legacy role: ${report.notLegacyHolders.length}`,
    `- Legacy per-group admins (not migrated; replaced by native chat admins): ${report.groupAdmins.people} people, ${report.groupAdmins.assignments} assignments`,
    "",
    "## Not linked in the IdP",
    ""
  )
  if (unlinked.length === 0) lines.push("Everyone has linked Telegram.")
  for (const holder of unlinked) lines.push(`- ${person(holder)}: ${holder.roles.join(", ")}`)
  lines.push("", "## Differences", "")
  if (differing.length === 0) lines.push("No differences for linked holders.")
  for (const holder of differing) {
    lines.push(`### ${person(holder)}`, "", `Legacy roles: ${holder.roles.join(", ")} · IdP subject: ${holder.sub}`, "")
    lines.push("| Check | Permission | Legacy | IdP | |", "| --- | --- | --- | --- | --- |")
    for (const check of holder.checks.filter((entry) => entry.status !== "match"))
      lines.push(
        `| ${check.id} | \`${check.permission}\` | ${check.legacy ? "yes" : "no"} | ${check.idp ? "yes" : "no"} | ${check.status === "missing" ? "loses access" : "gains access"} |`
      )
    lines.push("")
  }
  lines.push("## IdP subjects without a legacy role", "")
  if (report.notLegacyHolders.length === 0) lines.push("None.")
  for (const subject of report.notLegacyHolders)
    lines.push(`- ${subject.sub} (${subject.telegramId ?? "no Telegram link"}): ${subject.permissions.join(", ")}`)
  lines.push("", "## Checks", "")
  for (const check of LEGACY_CHECKS) lines.push(`- \`${check.id}\` → \`${check.permission}\`: ${check.description}`)
  return `${lines.join("\n")}\n`
}
