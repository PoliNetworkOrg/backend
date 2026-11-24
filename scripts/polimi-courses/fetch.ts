import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parseArgs } from "node:util"
import {
  type CourseEntry,
  type CourseFile,
  courseFileSchema,
  diffCourseFiles,
  type ListedCourse,
  MANIFESTI_SCHOOLS,
  MANIFESTI_URL,
  parseAcademicYear,
  parseCourseDetails,
  parseCourseList,
  rankingsDataCodes,
  sortCourses,
} from "../../src/polimi/manifesti"

/**
 * Builds one academic year's course list from Politecnico's manifesti (see README.md):
 *
 *   bun scripts/polimi-courses/fetch.ts --year 2026
 */

const { values } = parseArgs({
  options: {
    year: { type: "string" },
    "rankings-data": {
      type: "string",
      default: "https://raw.githubusercontent.com/PoliNetworkOrg/rankings-data/main/data/output/manifesti/all.json",
    },
  },
})
const year = Number(values.year)
if (!Number.isInteger(year) || year < 2021 || year > 2100) {
  console.error("Usage: bun scripts/polimi-courses/fetch.ts --year <first year of the academic year, e.g. 2026>")
  process.exit(2)
}
const dataDir = join(import.meta.dir, "data")
const fileName = (y: number) => `${y}-${String((y + 1) % 100).padStart(2, "0")}.json`
const DELAY_MS = 600
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; course-list-import)" }

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** The site answers 500 now and then: a few tries, slower each time. */
async function get(url: string, init?: RequestInit) {
  for (let attempt = 1; ; attempt++) {
    await sleep(DELAY_MS * attempt ** 2)
    const response = await fetch(url, {
      ...init,
      headers: { ...HEADERS, ...init?.headers },
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => {
      if (attempt >= 4) throw error
      return null
    })
    if (response?.ok) return response.text()
    if (attempt >= 4 || (response && response.status < 500)) throw new Error(`${response?.status} from ${url}`)
  }
}
/** A school's course select for the year, through the page's own search form. */
async function schoolPage(schoolId: string) {
  const body = new URLSearchParams({
    lang: "IT",
    aa: String(year),
    sede: "ALL_SEDI",
    k_cf: schoolId,
    evn_default: "Aggiorna",
  })
  return get(MANIFESTI_URL, {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  })
}
const coursePage = (code: number, academicYear: number) =>
  get(`${MANIFESTI_URL}?evn_default=EVENTO&aa=${academicYear}&k_corso_la=${code}`)

/** The page's "Ordinamento 270/04" or "D.M. 1648-1649/23" in the select's terms ("270", "96/23"). */
const regulationOf = (raw: string) => (/270/.test(raw) ? "270" : /\/23\b/.test(raw) ? "96/23" : raw)

async function previousFile(): Promise<CourseFile | null> {
  const files = (await readdir(dataDir).catch(() => []))
    .filter((name) => /^\d{4}-\d{2}\.json$/.test(name) && Number(name.slice(0, 4)) < year)
    .sort()
  const last = files.at(-1)
  return last ? courseFileSchema.parse(JSON.parse(await readFile(join(dataDir, last), "utf8"))) : null
}

const listed = new Map<number, ListedCourse>()
for (const schoolId of Object.keys(MANIFESTI_SCHOOLS)) {
  const html = await schoolPage(schoolId)
  if (parseAcademicYear(html) !== year) throw new Error(`The manifesti don't offer ${year} for school ${schoolId}`)
  const courses = parseCourseList(html)
  for (const course of courses) listed.set(course.code, course)
  console.log(`School ${MANIFESTI_SCHOOLS[schoolId as keyof typeof MANIFESTI_SCHOOLS]}: ${courses.length} courses`)
}

const rankingsCodes = rankingsDataCodes(JSON.parse(await get(values["rankings-data"] as string)))
const previous = await previousFile()
const entries: CourseEntry[] = []
const problems: string[] = []

let done = 0
for (const course of listed.values()) {
  if (++done % 20 === 0) console.log(`Read ${done} of ${listed.size} course pages`)
  const html = await coursePage(course.code, year).catch((error: Error) => {
    problems.push(`${course.code} ${course.name}: ${error.message}`)
    return null
  })
  if (html === null) continue
  const details = parseCourseDetails(html)
  if (details?.code !== course.code) {
    problems.push(`${course.code} ${course.name}: listed, but its page shows no details for ${year}`)
    continue
  }
  entries.push({
    code: course.code,
    name: course.name,
    level: course.level,
    school: details.school,
    regulation: course.regulation,
    campuses: details.campuses,
    languages: details.languages,
    activeYears: details.activeYears,
    degreeClass: details.degreeClass,
    active: true,
  })
}

/** Courses the year no longer offers: from rankings-data, or kept from the previous file. They stay, inactive. */
const inactive = new Set(
  [...rankingsCodes, ...(previous?.courses.map((c) => c.code) ?? [])].filter((c) => !listed.has(c))
)
console.log(`Looking up ${inactive.size} courses no longer offered`)
for (const code of [...inactive].sort((a, b) => a - b)) {
  const kept = previous?.courses.find((c) => c.code === code)
  if (kept) {
    entries.push({ ...kept, active: false })
    continue
  }
  let found = false
  for (let y = year - 1; y >= 2021 && !found; y--) {
    const html = await coursePage(code, y).catch((error: Error) => {
      console.error(`${code} in ${y}: ${error.message}`)
      return ""
    })
    const details = html ? parseCourseDetails(html) : null
    if (details?.code !== code) continue
    const raw = html.match(/Ordinamento\s*([^<]+)</)?.[1] ?? ""
    entries.push({
      code,
      name: details.name,
      level: details.level,
      school: details.school,
      regulation: regulationOf(raw.trim()),
      campuses: details.campuses,
      languages: details.languages,
      activeYears: details.activeYears,
      degreeClass: details.degreeClass,
      active: false,
    })
    found = true
  }
  if (!found) problems.push(`${code}: in rankings-data, but no academic year since 2021 has its page`)
}

const file: CourseFile = courseFileSchema.parse({ academicYear: year, courses: sortCourses(entries) })
const path = join(dataDir, fileName(year))
// Lists of strings and numbers on one line, as the repo's formatter (Biome) writes them.
const json = JSON.stringify(file, null, 2).replace(
  /\[\n\s*([^[\]{}]*?)\n\s*\]/g,
  (_, items: string) => `[${items.replace(/,\n\s*/g, ", ")}]`
)
await writeFile(path, `${json}\n`)

const active = file.courses.filter((c) => c.active)
console.log(
  `\nWrote ${path}: ${active.length} offered in ${year}/${year + 1}, ${file.courses.length - active.length} inactive`
)
console.log(
  `rankings-data: ${rankingsCodes.length} codes, ${rankingsCodes.filter((c) => !listed.has(c)).length} no longer offered`
)
if (previous) {
  const { added, removed, changed } = diffCourseFiles(previous, file)
  console.log(`\nSince ${previous.academicYear}/${previous.academicYear + 1}:`)
  for (const c of added) console.log(`  + ${c.code} ${c.name}`)
  for (const c of removed) console.log(`  - ${c.code} ${c.name}`)
  for (const c of changed) console.log(`  ~ ${c.code} ${c.name}: ${c.fields.join(", ")}`)
}
if (problems.length) {
  console.log("\nProblems:")
  for (const problem of problems) console.log(`  ${problem}`)
  process.exitCode = 1
}
