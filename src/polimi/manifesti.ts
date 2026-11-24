import { parse } from "node-html-parser"
import { z } from "zod"

/**
 * Parses Politecnico's public "manifesti degli studi" pages
 * (`https://onlineservices.polimi.it/manifesti/manifesti/controller/MostraIndirizziPublic.do`), the official source of
 * its degree courses. Pure functions over the HTML, so the yearly import script and the tests share them.
 */

export const MANIFESTI_URL = "https://onlineservices.polimi.it/manifesti/manifesti/controller/MostraIndirizziPublic.do"

/** The schools' ids in the page's `k_cf` select, and ours. The fifth option (Scuola di Specializzazione) isn't ours. */
export const MANIFESTI_SCHOOLS = { "222": "auic", "19": "design", "225": "3i", "1": "icat" } as const
export type ManifestiSchool = (typeof MANIFESTI_SCHOOLS)[keyof typeof MANIFESTI_SCHOOLS]

const LEVELS = {
  "laurea di primo livello": "bachelor",
  "laurea magistrale": "master",
  "laurea a ciclo unico": "single-cycle",
} as const
export type ManifestiLevel = (typeof LEVELS)[keyof typeof LEVELS]

/** A course as the school's course select lists it, under its level and regulation. */
export type ListedCourse = { code: number; name: string; level: ManifestiLevel; regulation: string }

/** What one course's page says about it under "Informazioni generali". */
export type CourseDetails = {
  code: number
  name: string
  school: ManifestiSchool
  level: ManifestiLevel
  campuses: string[]
  languages: string[]
  /** "1,2,3" on the page: the years of the course still taught. */
  activeYears: number[]
  degreeClass: string
}

export const courseEntrySchema = z.object({
  code: z.number().int().positive(),
  /** As the school's course select names it, e.g. "Ingegneria Gestionale - CR". */
  name: z.string().min(1),
  level: z.enum(["bachelor", "master", "single-cycle"]),
  school: z.enum(["auic", "icat", "3i", "design"]),
  /** The regulation it runs under, e.g. "96/23" (current) or "270" (older, until its students finish). */
  regulation: z.string().min(1),
  campuses: z.array(z.string()),
  languages: z.array(z.string()),
  activeYears: z.array(z.number().int()),
  degreeClass: z.string(),
  /** Offered in the file's academic year. */
  active: z.boolean(),
})
export type CourseEntry = z.infer<typeof courseEntrySchema>
export const courseFileSchema = z.object({
  /** The first calendar year of the academic year, e.g. 2026 for 2026/2027. */
  academicYear: z.number().int(),
  courses: z.array(courseEntrySchema),
})
export type CourseFile = z.infer<typeof courseFileSchema>

const clean = (text: string) =>
  text
    .replace(/&nbsp;| /g, " ")
    .replace(/\s+/g, " ")
    .trim()

function levelOf(text: string): ManifestiLevel {
  const lower = clean(text).toLowerCase()
  for (const [prefix, level] of Object.entries(LEVELS)) if (lower.startsWith(prefix)) return level
  throw new Error(`Unknown course level: ${text}`)
}

/** Every course in the page's course select (the selected school's, for the selected academic year). */
export function parseCourseList(html: string): ListedCourse[] {
  const select = parse(html).querySelector('select[name="k_corso_la"]')
  if (!select) throw new Error("The page has no course select")
  return select.querySelectorAll("optgroup").flatMap((group) => {
    // e.g. "Laurea di Primo Livello - ord. 96/23"
    const label = clean(group.getAttribute("label") ?? "")
    const regulation = label.match(/ord\.\s*(.+)$/i)?.[1]?.trim()
    if (!regulation) throw new Error(`Unknown course group: ${label}`)
    const level = levelOf(label)
    return group.querySelectorAll("option").map((option) => {
      const code = Number(option.getAttribute("value"))
      const name = clean(option.text).replace(new RegExp(`\\s*\\(${code}\\)$`), "")
      if (!Number.isInteger(code) || code <= 0 || !name) throw new Error(`Unreadable course option: ${option.text}`)
      return { code, name, level, regulation }
    })
  })
}

/** The page's selected academic year (its first calendar year). */
export function parseAcademicYear(html: string): number | null {
  const selected = parse(html).querySelector('select[name="aa"] option[selected]')
  return selected ? Number(selected.getAttribute("value")) : null
}

/**
 * The "Informazioni generali" table of the course the page shows. A page asked for a course its academic year doesn't
 * offer shows another one, so callers compare `code` with the one they asked for.
 */
export function parseCourseDetails(html: string): CourseDetails | null {
  const root = parse(html)
  const fields = new Map<string, string>()
  // The card's label cells; the search form above it has a "Scuola" label too, in other cells.
  for (const cell of root.querySelectorAll("td.ElementInfoCard1.jaf-card-element")) {
    const label = clean(cell.text)
    const value = cell.nextElementSibling
    if (label && value?.tagName === "TD" && !fields.has(label)) fields.set(label, clean(value.text))
  }
  const course = fields.get("Corso di Studio")?.match(/^(.*)\((\d+)\)$/)
  const schoolName = fields.get("Scuola")
  const level = fields.get("Livello")
  if (!course || !schoolName || !level) return null
  const school = schoolOf(schoolName)
  const list = (value: string | undefined) =>
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
  return {
    code: Number(course[2]),
    name: clean(course[1] as string),
    school,
    level: levelOf(level),
    campuses: list(fields.get("Sede del corso")),
    // "Lingua/e ufficiali", sometimes with a footnote mark, and a value that can be a sentence.
    languages: languagesOf([...fields].find(([label]) => label.startsWith("Lingua"))?.[1] ?? ""),
    activeYears: list(fields.get("Anni di Corso Attivi"))
      .map(Number)
      .filter((year) => Number.isInteger(year)),
    degreeClass: fields.get("Classe di Laurea") ?? "",
  }
}

/**
 * The languages a course page's language field names: "Italiano", "Italiano/Inglese (¹) …", or a note like "Il corso
 * … è erogato in lingua inglese ma …".
 */
export function languagesOf(text: string): string[] {
  const languages: string[] = []
  if (/italian/i.test(text)) languages.push("Italiano")
  if (/ingles|english/i.test(text)) languages.push("Inglese")
  return languages
}

/** The school a course page names, e.g. "Ingegneria Industriale e dell'Informazione" (the site starts some with a URL). */
export function schoolOf(text: string): ManifestiSchool {
  const name = clean(text).toLowerCase()
  if (name.includes("architettura")) return "auic"
  if (name.includes("design")) return "design"
  if (name.includes("industriale")) return "3i"
  if (name.includes("civile")) return "icat"
  throw new Error(`Unknown school: ${text}`)
}

/** The course codes in a `rankings-data` manifesti file: `{ data: { name: { campus: url } } }`. */
export function rankingsDataCodes(json: unknown): number[] {
  const file = z.object({ data: z.record(z.string(), z.record(z.string(), z.string())) }).parse(json)
  const codes = Object.values(file.data).flatMap((campuses) =>
    Object.values(campuses).flatMap((url) => {
      const code = new URL(url).searchParams.get("k_corso_la")
      return code && /^\d+$/.test(code) ? [Number(code)] : []
    })
  )
  return [...new Set(codes)].sort((a, b) => a - b)
}

const LEVEL_ORDER = ["bachelor", "single-cycle", "master"] as const
const SCHOOL_ORDER = ["auic", "design", "icat", "3i"] as const
/** Stable order for the committed file: school, level, current regulation first, name, code. */
export function sortCourses(courses: CourseEntry[]) {
  return [...courses].sort(
    (a, b) =>
      SCHOOL_ORDER.indexOf(a.school) - SCHOOL_ORDER.indexOf(b.school) ||
      LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) ||
      Number(b.active) - Number(a.active) ||
      b.regulation.localeCompare(a.regulation) ||
      a.name.localeCompare(b.name, "it") ||
      a.code - b.code
  )
}

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`
const textArray = (values: string[]) => `array[${values.map(literal).join(", ")}]::text[]`
const intArray = (values: number[]) => `array[${values.join(", ")}]::integer[]`

/**
 * The data migration for one year's file: inserts or updates every course by code, and marks inactive the ones the file
 * doesn't list. Never deletes: People records point to courses.
 */
export function coursesMigrationSql(file: CourseFile) {
  const rows = file.courses.map((c) =>
    [
      c.code,
      literal(c.name),
      literal(c.level),
      literal(c.school),
      literal(c.regulation),
      textArray(c.campuses),
      textArray(c.languages),
      intArray(c.activeYears),
      literal(c.degreeClass),
      c.active,
      file.academicYear,
    ].join(", ")
  )
  const codes = file.courses.map((c) => c.code).join(", ")
  return [
    `-- Politecnico's courses for ${file.academicYear}/${file.academicYear + 1}, from scripts/polimi-courses/data.`,
    `INSERT INTO "polimi_courses" ("code", "name", "level", "school", "regulation", "campuses", "languages", "active_years", "degree_class", "active", "academic_year") VALUES`,
    `${rows.map((row) => `(${row})`).join(",\n")}`,
    `ON CONFLICT ("code") DO UPDATE SET "name" = excluded."name", "level" = excluded."level", "school" = excluded."school", "regulation" = excluded."regulation", "campuses" = excluded."campuses", "languages" = excluded."languages", "active_years" = excluded."active_years", "degree_class" = excluded."degree_class", "active" = excluded."active", "academic_year" = excluded."academic_year";`,
    "--> statement-breakpoint",
    `UPDATE "polimi_courses" SET "active" = false WHERE "code" NOT IN (${codes});`,
    "",
  ].join("\n")
}

/** What changed from one year's file to the next, for the person reviewing the update. */
export function diffCourseFiles(previous: CourseFile | null, next: CourseFile) {
  const before = new Map((previous?.courses ?? []).map((c) => [c.code, c]))
  const after = new Map(next.courses.map((c) => [c.code, c]))
  const added = next.courses.filter((c) => !before.has(c.code))
  const removed = [...before.values()].filter((c) => !after.has(c.code))
  const changed = next.courses.flatMap((c) => {
    const old = before.get(c.code)
    if (!old) return []
    const fields = (Object.keys(c) as (keyof CourseEntry)[]).filter(
      (key) => JSON.stringify(c[key]) !== JSON.stringify(old[key])
    )
    return fields.length ? [{ code: c.code, name: c.name, fields }] : []
  })
  return { added, removed, changed }
}
