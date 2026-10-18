import { XMLParser, XMLValidator } from "fast-xml-parser"
import { Unzip, UnzipInflate } from "fflate"
import { z } from "zod"
import { type CensusAnswer, createPersonInputSchema, teamIdSchema } from "./contract"
import { fail, hash } from "./model"

export const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_EXPANDED_BYTES = 50 * 1024 * 1024
const MAX_ROWS = 5000

/** Stream inflation enforces actual output sizes, including ZIPs with forged size headers. No files reach disk. */
export function unzipBounded(bytes: Uint8Array): Record<string, Uint8Array> {
  const output: Record<string, Uint8Array> = Object.create(null)
  let count = 0
  let total = 0
  const archive = new Unzip((entry) => {
    if (++count > 1000 || (entry.originalSize && entry.originalSize > MAX_EXPANDED_BYTES))
      fail("BAD_REQUEST", "Archive exceeds import limits")
    if (entry.name.includes("..") || entry.name.startsWith("/") || entry.name in output)
      fail("BAD_REQUEST", "Invalid archive entry")
    const parts: Uint8Array[] = []
    let length = 0
    entry.ondata = (error, chunk, final) => {
      if (error) throw error
      total += chunk.length
      length += chunk.length
      if (total > MAX_EXPANDED_BYTES) {
        entry.terminate()
        fail("BAD_REQUEST", "Expanded import exceeds 50 MB")
      }
      parts.push(chunk)
      if (final) {
        const value = new Uint8Array(length)
        let offset = 0
        for (const part of parts) {
          value.set(part, offset)
          offset += part.length
        }
        output[entry.name] = value
      }
    }
    entry.start()
  })
  archive.register(UnzipInflate)
  // Bound the amount inflated before ondata can enforce the actual-output budget, even with forged ZIP sizes.
  for (let offset = 0; offset < bytes.length; offset += 1024)
    archive.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length)
  if (!count) fail("BAD_REQUEST", "Empty or invalid archive")
  return output
}

export function parseCsv(text: string): string[][] {
  const firstLine = text.split(/\r?\n/, 1)[0]
  const delimiter = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ","
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (char === '"' && quoted && text[i + 1] === '"') {
      cell += '"'
      i++
      continue
    }
    if (char === '"') {
      if (!quoted && cell) fail("BAD_REQUEST", "Malformed CSV quoting")
      quoted = !quoted
      continue
    }
    if (!quoted && (char === delimiter || char === "\n" || char === "\r")) {
      row.push(cell)
      cell = ""
      if (char !== delimiter) {
        if (char === "\r" && text[i + 1] === "\n") i++
        if (row.some(Boolean)) rows.push(row)
        row = []
        if (rows.length > MAX_ROWS + 1) fail("BAD_REQUEST", "Import exceeds 5,000 responses")
      }
    } else cell += char
    if (cell.length > 10000 || row.length > 200) fail("BAD_REQUEST", "Import cell or column limit exceeded")
  }
  if (quoted) fail("BAD_REQUEST", "Unclosed CSV quote")
  row.push(cell)
  if (row.some(Boolean)) rows.push(row)
  return rows
}

type Xml = { [key: string]: Xml | Xml[] | string | number }
const decoder = new TextDecoder("utf-8", { fatal: true })
function xml(bytes?: Uint8Array): Xml {
  if (!bytes) return {}
  const text = decoder.decode(bytes)
  if (/<!DOCTYPE|<!ENTITY/i.test(text) || XMLValidator.validate(text) !== true)
    fail("BAD_REQUEST", "Invalid workbook XML")
  return new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    processEntities: true,
    isArray: (name) => ["si", "row", "c", "r"].includes(name),
  }).parse(text)
}
function richText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (!value || typeof value !== "object") return ""
  const obj = value as { t?: unknown; r?: unknown[]; "#text"?: string }
  return obj.t !== undefined ? richText(obj.t) : obj.r ? obj.r.map(richText).join("") : (obj["#text"] ?? "")
}
function parseXlsx(bytes: Uint8Array): string[][] {
  const zip = unzipBounded(bytes)
  if (!zip["[Content_Types].xml"] || !zip["xl/workbook.xml"]) fail("BAD_REQUEST", "This ZIP is not an XLSX workbook")
  const sheet = Object.keys(zip)
    .filter((key) => /^xl\/worksheets\/sheet\d+\.xml$/.test(key))
    .sort()[0]
  if (!sheet) fail("BAD_REQUEST", "Workbook has no worksheet")
  const sharedRoot = xml(zip["xl/sharedStrings.xml"]) as unknown as { sst?: { si?: unknown[] } }
  const shared = (sharedRoot.sst?.si ?? []).map(richText)
  const root = xml(zip[sheet]) as unknown as {
    worksheet?: {
      sheetData?: { row?: { c?: { "@_r"?: string; "@_t"?: string; v?: string; is?: unknown; f?: unknown }[] }[] }
    }
  }
  const rows: string[][] = []
  for (const source of root.worksheet?.sheetData?.row ?? []) {
    const row: string[] = []
    for (const cell of source.c ?? []) {
      if (cell.f !== undefined) fail("BAD_REQUEST", "Formula cells are not accepted in census imports")
      const letters = /^([A-Z]+)/.exec(cell["@_r"] ?? "")?.[1]
      const column = letters ? [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1 : row.length
      if (column >= 200) fail("BAD_REQUEST", "Import exceeds 200 columns")
      const value =
        cell["@_t"] === "s"
          ? (shared[Number(cell.v)] ?? "")
          : cell["@_t"] === "inlineStr"
            ? richText(cell.is)
            : (cell.v ?? "")
      if (value.length > 10000) fail("BAD_REQUEST", "Import cell is too long")
      row[column] = value
    }
    rows.push(Array.from({ length: row.length }, (_, i) => row[i] ?? ""))
    if (rows.length > MAX_ROWS + 1) fail("BAD_REQUEST", "Import exceeds 5,000 responses")
  }
  return rows
}

const normalize = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
const aliases: Record<string, string[]> = {
  firstName: ["firstName", "nome"],
  lastName: ["lastName", "cognome"],
  personalEmail: ["personalEmail", "email", "emailpersonale", "indirizzodipostaelettronica"],
  phone: ["phone", "telefono", "numeroditelefono"],
  telegramUsername: ["telegramUsername", "telegram", "usernametelegram"],
  course: ["course", "corso", "corsodilaurea"],
  year: ["year", "annodicorso"],
  campus: ["campus", "sede"],
  answer: ["answer", "continui", "continuare", "continues"],
  declaredMember: ["declaredMember", "socio"],
  answeredOn: ["answeredOn", "completiontime", "oradicompletamento"],
  admin: ["admin", "amministratore"],
  teams: ["teams", "team"],
  requestedGroups: ["requestedGroups", "gruppirichiesti"],
  availableAsCapo: ["availableAsCapo", "disponibilecomecapo"],
  otherAssociations: ["otherAssociations", "altreassociazioni"],
  studentRepresentative: ["studentRepresentative", "rappresentantestudenti"],
  privacyVersion: ["privacyVersion"],
  privacyAcceptedOn: ["privacyAcceptedOn"],
  photoConsent: ["photoConsent", "consensofoto"],
}
const volunteerInput = z.object({
  admin: z.boolean(),
  teams: z.array(teamIdSchema).max(5),
  requestedGroups: z.array(z.string().regex(/^-\d{1,16}$/)).max(100),
  availableAsCapo: z.boolean(),
  otherAssociations: z.array(z.string().max(100)).max(20).optional(),
  studentRepresentative: z.string().max(200).optional(),
  privacyVersion: z.string().max(80),
  privacyAcceptedOn: z.iso.date().nullable(),
  photoConsent: z.enum(["granted", "denied"]).nullable(),
})
export async function parseImport(file: File) {
  if (!file.size || file.size > MAX_FILE_BYTES) fail("BAD_REQUEST", "Import must be between 1 byte and 10 MB")
  const bytes = new Uint8Array(await file.arrayBuffer())
  let rows: string[][]
  try {
    rows =
      bytes[0] === 0x50 && bytes[1] === 0x4b ? parseXlsx(bytes) : parseCsv(decoder.decode(bytes).replace(/^\ufeff/, ""))
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error
    fail("BAD_REQUEST", "Cannot read a UTF-8 CSV or XLSX workbook")
  }
  if (rows.length < 2 || rows.length > MAX_ROWS + 1) fail("BAD_REQUEST", "Import must contain 1–5,000 responses")
  const headers = rows[0].map(normalize)
  const indexes = Object.fromEntries(
    Object.entries(aliases).map(([key, values]) => [key, headers.findIndex((h) => values.map(normalize).includes(h))])
  )
  for (const required of ["firstName", "lastName", "personalEmail", "course", "year", "campus", "answer"])
    if (indexes[required] < 0) fail("BAD_REQUEST", `Missing census column: ${required}`)
  return rows.slice(1).map((cells, i) => {
    const get = (key: string) => cells[indexes[key]]?.trim() ?? ""
    const profile = createPersonInputSchema.safeParse({
      ...Object.fromEntries(Object.keys(aliases).map((key) => [key, get(key)])),
      admin: false,
    })
    const answer: CensusAnswer | null = ["yes", "si", "continues"].includes(normalize(get("answer")))
      ? "continues"
      : ["no", "leaving"].includes(normalize(get("answer")))
        ? "leaving"
        : null
    const answered = get("answeredOn")
    const answeredOn = /^\d{4}-\d{2}-\d{2}/.test(answered) ? answered.slice(0, 10) : null
    const split = (key: string) =>
      get(key)
        .split(/[;|]/)
        .map((s) => s.trim())
        .filter(Boolean)
    const yes = (key: string) => ["yes", "si", "true", "1"].includes(normalize(get(key)))
    const volunteer = volunteerInput.safeParse({
      admin: yes("admin"),
      teams: split("teams").map((t) => t.toLowerCase()),
      requestedGroups: split("requestedGroups"),
      availableAsCapo: yes("availableAsCapo"),
      otherAssociations: indexes.otherAssociations >= 0 ? split("otherAssociations") : undefined,
      studentRepresentative: indexes.studentRepresentative >= 0 ? get("studentRepresentative") : undefined,
      privacyVersion: get("privacyVersion"),
      privacyAcceptedOn: get("privacyAcceptedOn") || null,
      photoConsent: get("photoConsent") || null,
    })
    return {
      row: i + 2,
      fingerprint: hash(JSON.stringify(cells)),
      profile: profile.success ? profile.data : null,
      answer,
      answeredOn,
      volunteer: volunteer.success ? volunteer.data : null,
      declaredMember: get("declaredMember")
        ? ["yes", "si", "true", "1"].includes(normalize(get("declaredMember")))
        : null,
      answers: cells.map((value, index) => ({ question: rows[0][index], answer: value })),
      error: !volunteer.success
        ? (volunteer.error.issues[0]?.message ?? "Invalid volunteer fields")
        : !profile.success
          ? (profile.error.issues[0]?.message ?? "Invalid profile")
          : !answer
            ? "Answer must be continues/leaving or yes/no"
            : null,
    }
  })
}
