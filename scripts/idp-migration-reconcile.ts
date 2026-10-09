/**
 * IdP–Telegram migration, Phase 2 step 5 (RFC v3 §13): compare every legacy role holder's
 * current decisions with the IdP access snapshot.
 *
 *   bun scripts/idp-migration-reconcile.ts --export <export.json> --snapshot <snapshot.json> \
 *     [--json <report.json>] [--at <ISO time>]
 *   bun scripts/idp-migration-reconcile.ts --export <export.json> --snapshot-url <url>
 *
 * With --snapshot-url, IDP_ACCESS_TOKEN must hold the backend client's access token for the
 * snapshot endpoint (RFC §5.3). The Markdown report is printed to stdout; it names people,
 * so do not paste it into public places.
 */
import { readFile, writeFile } from "node:fs/promises"
import { parseArgs } from "node:util"
import { accessSnapshotSchema, formatReport, legacyExportSchema, reconcile } from "./lib/legacy-access"

const { values } = parseArgs({
  options: {
    export: { type: "string" },
    snapshot: { type: "string" },
    "snapshot-url": { type: "string" },
    json: { type: "string" },
    at: { type: "string" },
  },
})

if (!values.export || !values.snapshot === !values["snapshot-url"]) {
  console.error(
    "Usage: bun scripts/idp-migration-reconcile.ts --export <export.json> (--snapshot <file> | --snapshot-url <url>) [--json <report.json>] [--at <ISO time>]"
  )
  process.exit(2)
}

async function loadSnapshot(): Promise<unknown> {
  if (values.snapshot) return JSON.parse(await readFile(values.snapshot, "utf8"))
  const token = process.env.IDP_ACCESS_TOKEN
  if (!token) throw new Error("IDP_ACCESS_TOKEN is required with --snapshot-url")
  const response = await fetch(values["snapshot-url"] as string, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
  if (!response.ok) throw new Error(`Snapshot request failed: HTTP ${response.status}`)
  return response.json()
}

const at = values.at ? new Date(values.at) : new Date()
if (Number.isNaN(at.getTime())) throw new Error(`Invalid --at time: ${values.at}`)

const legacy = legacyExportSchema.parse(JSON.parse(await readFile(values.export, "utf8")))
const snapshot = accessSnapshotSchema.parse(await loadSnapshot())
const report = reconcile(legacy, snapshot, at)

if (values.json) await writeFile(values.json, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
process.stdout.write(formatReport(report))
