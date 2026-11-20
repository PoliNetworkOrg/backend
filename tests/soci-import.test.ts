import { describe, expect, it } from "vitest"
import { CsvPreviewError, parseBookCsv } from "../src/soci/import-csv"
import { previewBookCsv } from "../src/soci/import-preview"

const mapping = {
  version: 1,
  delimiter: ";",
  dateFormat: "italian",
  scope: "unknown",
  columns: { number: "Numero", firstName: "Nome", lastName: "Cognome", admittedOn: "Data" },
}
const header = "Numero;Nome;Cognome;Data"
const basicRow = "000123;Mario;Rossi;01/09/2025"
const source = `${header}\n${basicRow}`
function errorCode(fn: () => unknown, code: string) {
  expect(fn).toThrow(CsvPreviewError)
  try {
    fn()
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}
function codes(report: ReturnType<typeof previewBookCsv>, row = 0) {
  return report.rows[row].diagnostics.map((d) => d.code)
}

describe("Libro Soci CSV parsing", () => {
  it("supports BOM, either delimiter, all newlines, escaped quotes and source line numbers", () => {
    expect(parseBookCsv('\uFEFFa;b\r\n"prima\r\nriga";"due""tre"\n\rquattro;\r', ";")).toEqual([
      { line: 1, cells: ["a", "b"] },
      { line: 2, cells: ["prima\r\nriga", 'due"tre'] },
      { line: 5, cells: ["quattro", ""] },
    ])
    expect(parseBookCsv('"a,b",c,', ",")).toEqual([{ line: 1, cells: ["a,b", "c", ""] }])
  })
  it("skips blank physical lines but retains deliberately empty records", () => {
    expect(parseBookCsv('\n\r\n;\n""\n', ";")).toEqual([
      { line: 3, cells: ["", ""] },
      { line: 4, cells: [""] },
    ])
  })
  it.each([
    ['a"b;c', "unexpected_quote"],
    ['"a"x;b', "characters_after_quote"],
    ['"a\nb', "unclosed_quote"],
    ["x".repeat(16_385), "cell_too_long"],
    [Array(257).fill("").join(";"), "too_many_columns"],
    ["x\n".repeat(50_002), "too_many_rows"],
  ])("rejects malformed or oversized records (%s)", (text, code) => {
    errorCode(() => parseBookCsv(text, ";"), code)
  })
})

describe("local Libro Soci normalization", () => {
  it("produces deterministic unresolved candidates without fabricating account or fee state", () => {
    const result = previewBookCsv(source, mapping)
    expect(result).toEqual(previewBookCsv(source, mapping))
    expect(result).toMatchObject({
      mode: "preview-only",
      reconciliation: "not_performed",
      summary: { rows: 1, normalized: 1, blocked: 0, unresolved: 1 },
    })
    expect(result.rows[0].candidate).toMatchObject({
      number: 123,
      admittedOn: "2025-09-01",
      membership: "unknown",
      account: { mailbox: null, entraObjectId: null },
      feeEvidence: [],
    })
    expect(codes(result)).toEqual(["membership_unknown", "account_unreconciled", "fee_evidence_unknown"])
  })
  it("retains payment text as unreviewed evidence and blanks as unknown", () => {
    const result = previewBookCsv(
      `${source};pagata\n124;Persona;Esempio;02/09/2025;`.replace(header, `${header};Quota`),
      { ...mapping, feeEvidence: [{ label: "Quota", column: "Quota" }] }
    )
    expect(result.rows.map((r) => r.candidate?.feeEvidence)).toEqual([
      [{ label: "Quota", value: "pagata", status: "unreviewed" }],
      [{ label: "Quota", value: null, status: "unknown" }],
    ])
    expect(result.summary.blocked).toBe(0)
  })
  it("normalizes tax codes, optional fields and validates the actual contract", () => {
    const config = {
      ...mapping,
      columns: { ...mapping.columns, codiceFiscale: "CF", birthDate: "Nascita", phone: "Telefono" },
    }
    const csv = `${header};CF;Nascita;Telefono\n${basicRow};rss mra80a01h501u;01/01/1980;+39 333 1234567`
    expect(previewBookCsv(csv, config).rows[0].candidate?.details).toMatchObject({
      codiceFiscale: "RSSMRA80A01H501U",
      birthDate: "1980-01-01",
      phone: "+393331234567",
      residence: null,
    })
    const bad = previewBookCsv(csv.replace("01/01/1980", "02/01/1980"), config)
    expect(bad.rows[0].status).toBe("blocked")
    expect(bad.rows[0].candidate).toBeNull()
    expect(previewBookCsv(csv.replace("h501u", "h501a"), config).summary.blocked).toBe(1)
  })
  it.each(["31/02/2025", "29/02/2025", "1/09/2025", "2025-09-01"])("rejects invalid or ambiguous dates %s", (date) => {
    expect(previewBookCsv(source.replace("01/09/2025", date), mapping).summary.blocked).toBe(1)
  })
  it("accepts leap dates and explicit ISO format", () => {
    expect(previewBookCsv(source.replace("01/09/2025", "29/02/2024"), mapping).summary.blocked).toBe(0)
    expect(
      previewBookCsv(source.replace("01/09/2025", "2025-09-01"), { ...mapping, dateFormat: "iso" }).summary.blocked
    ).toBe(0)
  })
  it.each(["0", "1000000", "1e2", "-1", "1.2"])("rejects invalid member number %s", (number) => {
    expect(previewBookCsv(source.replace("000123", number), mapping).summary.blocked).toBe(1)
  })
  it("requires all headers to be explicitly mapped or ignored", () => {
    errorCode(() => previewBookCsv(`${header};Secret\n${basicRow};x`, mapping), "unmapped_column")
    expect(
      previewBookCsv(`${header};Secret\n${basicRow};x`, { ...mapping, ignoredColumns: ["Secret"] }).summary.blocked
    ).toBe(0)
    errorCode(() => previewBookCsv(source, { ...mapping, ignoredColumns: ["Nome"] }), "invalid_mapping")
    errorCode(() => previewBookCsv(source, { ...mapping, apply: true }), "invalid_mapping")
    errorCode(() => previewBookCsv(source, { ...mapping, scope: "history" }), "invalid_mapping")
    errorCode(() => previewBookCsv(source.replace("Nome", "Altro"), mapping), "missing_column")
    errorCode(() => previewBookCsv(source.replace("Nome", "Numero"), mapping), "duplicate_header")
    errorCode(() => previewBookCsv(source.replace("Nome", ""), mapping), "empty_header")
    errorCode(() => previewBookCsv("", mapping), "missing_header")
  })
  it("retains ragged rows as blocked and supports header-only books", () => {
    expect(codes(previewBookCsv(`${header}\n123;Mario`, mapping))).toEqual(["column_count"])
    expect(previewBookCsv(header, mapping).summary).toEqual({ rows: 0, normalized: 0, blocked: 0, unresolved: 0 })
  })
  it("rejects reused source columns and duplicate evidence labels", () => {
    errorCode(
      () => previewBookCsv(source, { ...mapping, columns: { ...mapping.columns, firstName: "Numero" } }),
      "invalid_mapping"
    )
    errorCode(
      () => previewBookCsv(source, { ...mapping, feeEvidence: [{ label: "Quota", column: "Nome" }] }),
      "invalid_mapping"
    )
    errorCode(
      () =>
        previewBookCsv(source, {
          ...mapping,
          feeEvidence: [
            { label: "Quota", column: "A" },
            { label: "Quota", column: "B" },
          ],
        }),
      "invalid_mapping"
    )
  })
  it("blocks both identical and conflicting member numbers, even when another field is invalid", () => {
    const identical = previewBookCsv(`${source}\n${basicRow}`, mapping)
    expect(identical.summary.blocked).toBe(2)
    expect(identical.rows.every((r) => r.diagnostics.some((d) => d.code === "duplicate_row"))).toBe(true)
    const conflicting = previewBookCsv(`${source}\n123;;Altro;01/09/2025`, mapping)
    expect(conflicting.summary.blocked).toBe(2)
    expect(conflicting.rows.every((r) => r.diagnostics.some((d) => d.code === "duplicate_number"))).toBe(true)
    expect(previewBookCsv(`${source}\n123;Mario`, mapping).summary.blocked).toBe(2)
  })
  it("preserves historical re-admissions and blocks multiple explicitly active identities", () => {
    const config = {
      ...mapping,
      scope: "history",
      columns: { ...mapping.columns, codiceFiscale: "CF", endedOn: "Fine", endReason: "Motivo" },
      endReasonValues: { dimissioni: "resigned" },
    }
    const csv = `${header};CF;Fine;Motivo\n${basicRow};RSSMRA80A01H501U;02/09/2025;dimissioni\n124;Mario;Rossi;03/09/2025;RSSMRA80A01H501U;;`
    const result = previewBookCsv(csv, config)
    expect(result.summary.blocked).toBe(0)
    expect(result.rows.map((r) => r.candidate?.membership)).toEqual(["ended", "active"])
    expect(codes(result)).toContain("identity_review")
    const active = csv.replace("02/09/2025;dimissioni", ";")
    expect(previewBookCsv(active, config).summary.blocked).toBe(2)
    expect(codes(previewBookCsv(active, config))).toContain("active_code_conflict")
    expect(previewBookCsv(active, { ...config, scope: "unknown" }).summary.blocked).toBe(0)
    expect(codes(previewBookCsv(csv, { ...config, scope: "active-only" }))).toContain("ended_in_active_scope")
    expect(codes(previewBookCsv(csv.replace("02/09/2025", "01/08/2025"), config))).toContain("end_before_admission")
    expect(codes(previewBookCsv(csv.replace("02/09/2025;dimissioni", ";dimissioni"), config))).toContain(
      "incomplete_end"
    )
  })
})
