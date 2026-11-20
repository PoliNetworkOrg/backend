import { z } from "zod"
import { END_REASONS, memberNumberSchema, optionalDetailsSchema } from "./contract"
import { CsvPreviewError, parseBookCsv } from "./import-csv"

const header = z.string().trim().min(1).max(200)
export const bookMappingSchema = z
  .strictObject({
    version: z.literal(1),
    delimiter: z.enum([",", ";"]),
    dateFormat: z.enum(["iso", "italian"]),
    scope: z.enum(["active-only", "history", "unknown"]),
    columns: z.strictObject({
      number: header,
      firstName: header,
      lastName: header,
      admittedOn: header,
      alias: header.optional(),
      codiceFiscale: header.optional(),
      birthDate: header.optional(),
      birthPlace: header.optional(),
      residence: header.optional(),
      phone: header.optional(),
      endedOn: header.optional(),
      endReason: header.optional(),
      endNote: header.optional(),
      mailbox: header.optional(),
      entraObjectId: header.optional(),
    }),
    ignoredColumns: z.array(header).max(256).default([]),
    feeEvidence: z
      .array(z.strictObject({ label: z.string().trim().min(1).max(80), column: header }))
      .max(100)
      .default([]),
    endReasonValues: z.record(z.string().min(1).max(80), z.enum(END_REASONS)).default({}),
  })
  .superRefine((mapping, ctx) => {
    const used = [...Object.values(mapping.columns), ...mapping.feeEvidence.map((f) => f.column)]
    if (
      new Set(used).size !== used.length ||
      mapping.ignoredColumns.some((name) => used.includes(name)) ||
      new Set(mapping.feeEvidence.map((f) => f.label)).size !== mapping.feeEvidence.length ||
      (mapping.scope === "history" && (!mapping.columns.endedOn || !mapping.columns.endReason)) ||
      Object.keys(mapping.endReasonValues).length > 100
    )
      ctx.addIssue({ code: "custom", message: "Inconsistent mapping" })
  })
export type BookMapping = z.output<typeof bookMappingSchema>

const candidateSchema = z.object({
  number: memberNumberSchema,
  details: optionalDetailsSchema,
  admittedOn: z.iso.date(),
  endedOn: z.iso.date().nullable(),
  endReason: z.enum(END_REASONS).nullable(),
  endNote: z.string().trim().min(1).max(500).nullable(),
  account: z.object({
    mailbox: z.email().nullable(),
    entraObjectId: z.string().trim().min(1).max(128).nullable(),
  }),
})
export type BookCandidate = z.output<typeof candidateSchema> & {
  membership: "active" | "ended" | "unknown"
  feeEvidence: { label: string; value: string | null; status: "unknown" | "unreviewed" }[]
}
export type BookDiagnostic = {
  severity: "error" | "warning"
  code: string
  field?: string
  relatedLine?: number
  matches?: number
}
export type BookPreviewRow = {
  line: number
  status: "blocked" | "unresolved"
  candidate: BookCandidate | null
  diagnostics: BookDiagnostic[]
}

function dateValue(value: string, format: BookMapping["dateFormat"]): string | null {
  if (!value) return null
  if (format === "iso") return value
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value)
  return match ? `${match[3]}-${match[2]}-${match[1]}` : "invalid-date"
}

/** No I/O or configured services. All successful candidates still require reconciliation. */
export function previewBookCsv(source: string, config: unknown) {
  const mappingResult = bookMappingSchema.safeParse(config)
  if (!mappingResult.success) throw new CsvPreviewError("invalid_mapping")
  const mapping = mappingResult.data
  const records = parseBookCsv(source, mapping.delimiter)
  const first = records[0]
  if (!first) throw new CsvPreviewError("missing_header")
  const headers = first.cells.map((name) => name.trim())
  const positions = new Map<string, number>()
  for (const [index, name] of headers.entries()) {
    if (!name) throw new CsvPreviewError("empty_header", first.line, index + 1)
    if (positions.has(name)) throw new CsvPreviewError("duplicate_header", first.line, index + 1)
    positions.set(name, index)
  }
  const namedColumns = [
    ...Object.values(mapping.columns),
    ...mapping.ignoredColumns,
    ...mapping.feeEvidence.map((f) => f.column),
  ]
  for (const name of namedColumns) if (!positions.has(name)) throw new CsvPreviewError("missing_column", first.line)
  for (const [index, name] of headers.entries())
    if (!namedColumns.includes(name)) throw new CsvPreviewError("unmapped_column", first.line, index + 1)

  const numbers = new Map<number, BookPreviewRow[]>()
  const codes = new Map<string, BookPreviewRow[]>()
  const rows: BookPreviewRow[] = records.slice(1).map((record) => {
    const row: BookPreviewRow = { line: record.line, status: "unresolved", candidate: null, diagnostics: [] }
    const readColumn = (name: string | undefined) =>
      name === undefined ? "" : (record.cells[positions.get(name) ?? -1] ?? "").trim()
    const read = (key: keyof BookMapping["columns"]) => readColumn(mapping.columns[key])
    const number = /^\d{1,6}$/.test(read("number")) ? Number(read("number")) : 0
    if (memberNumberSchema.safeParse(number).success) {
      const group = numbers.get(number) ?? []
      group.push(row)
      numbers.set(number, group)
    }
    if (record.cells.length !== headers.length) {
      row.status = "blocked"
      row.diagnostics.push({ severity: "error", code: "column_count" })
      return row
    }
    const endedOn = dateValue(read("endedOn"), mapping.dateFormat)
    const rawReason = read("endReason")
    const endReason =
      rawReason && Object.hasOwn(mapping.endReasonValues, rawReason)
        ? mapping.endReasonValues[rawReason]
        : rawReason || null
    const parsed = candidateSchema.safeParse({
      number,
      details: {
        firstName: read("firstName"),
        lastName: read("lastName"),
        alias: read("alias"),
        codiceFiscale: read("codiceFiscale"),
        birthDate: dateValue(read("birthDate"), mapping.dateFormat),
        birthPlace: read("birthPlace"),
        residence: read("residence"),
        phone: read("phone"),
      },
      admittedOn: dateValue(read("admittedOn"), mapping.dateFormat),
      endedOn,
      endReason,
      endNote: read("endNote") || null,
      account: { mailbox: read("mailbox") || null, entraObjectId: read("entraObjectId") || null },
    })
    if (!parsed.success) {
      row.status = "blocked"
      row.diagnostics = parsed.error.issues.map((issue) => ({
        severity: "error",
        code: "invalid_value",
        field: issue.path.join("."),
      }))
      return row
    }
    const c = parsed.data
    if ((c.endedOn === null) !== (c.endReason === null) || (!c.endedOn && c.endNote))
      row.diagnostics.push({ severity: "error", code: "incomplete_end", field: "endedOn" })
    if (c.endedOn && c.endedOn < c.admittedOn)
      row.diagnostics.push({ severity: "error", code: "end_before_admission", field: "endedOn" })
    if (c.endedOn && mapping.scope === "active-only")
      row.diagnostics.push({ severity: "error", code: "ended_in_active_scope", field: "endedOn" })
    const membership = c.endedOn ? "ended" : mapping.scope === "unknown" ? "unknown" : "active"
    row.candidate = {
      ...c,
      membership,
      feeEvidence: mapping.feeEvidence.map((f) => {
        const value = readColumn(f.column) || null
        return { label: f.label, value, status: value === null ? "unknown" : "unreviewed" }
      }),
    }
    if (membership === "unknown") row.diagnostics.push({ severity: "warning", code: "membership_unknown" })
    row.diagnostics.push({ severity: "warning", code: "account_unreconciled", field: "account" })
    row.diagnostics.push({
      severity: "warning",
      code: row.candidate.feeEvidence.some((f) => f.value !== null)
        ? "fee_evidence_unreviewed"
        : "fee_evidence_unknown",
      field: "feeEvidence",
    })
    if (c.details.codiceFiscale) {
      const group = codes.get(c.details.codiceFiscale) ?? []
      group.push(row)
      codes.set(c.details.codiceFiscale, group)
    }
    return row
  })

  for (const group of numbers.values()) {
    if (group.length < 2) continue
    const firstCandidate = JSON.stringify(group[0].candidate)
    const identical = group.every((r) => r.candidate !== null && JSON.stringify(r.candidate) === firstCandidate)
    for (const row of group)
      row.diagnostics.push({
        severity: "error",
        code: identical ? "duplicate_row" : "duplicate_number",
        field: "number",
        relatedLine: (group[0] === row ? group[1] : group[0]).line,
        matches: group.length - 1,
      })
  }
  for (const group of codes.values()) {
    if (group.length < 2) continue
    const active = group.filter((r) => r.candidate?.membership === "active")
    for (const row of group) {
      const conflict = active.length > 1 && row.candidate?.membership === "active"
      row.diagnostics.push({
        severity: conflict ? "error" : "warning",
        code: conflict ? "active_code_conflict" : "identity_review",
        field: "details.codiceFiscale",
        relatedLine: (group[0] === row ? group[1] : group[0]).line,
        matches: group.length - 1,
      })
    }
  }
  for (const row of rows) row.status = row.diagnostics.some((d) => d.severity === "error") ? "blocked" : "unresolved"
  return {
    version: 1 as const,
    mode: "preview-only" as const,
    reconciliation: "not_performed" as const,
    summary: {
      rows: rows.length,
      normalized: rows.filter((r) => r.candidate !== null).length,
      blocked: rows.filter((r) => r.status === "blocked").length,
      unresolved: rows.filter((r) => r.status === "unresolved").length,
    },
    rows,
  }
}
