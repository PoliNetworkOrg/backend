import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
  type CourseEntry,
  coursesMigrationSql,
  diffCourseFiles,
  parseAcademicYear,
  parseCourseDetails,
  parseCourseList,
  rankingsDataCodes,
  schoolOf,
  sortCourses,
} from "@/polimi/manifesti"

const page = (name: string) => readFileSync(new URL(`./fixtures/polimi/${name}`, import.meta.url), "utf8")

const entry = (overrides: Partial<CourseEntry> = {}): CourseEntry => ({
  code: 531,
  name: "Ingegneria Informatica",
  level: "bachelor",
  school: "3i",
  regulation: "96/23",
  campuses: ["Milano Leonardo", "Cremona"],
  languages: ["Italiano"],
  activeYears: [1, 2, 3],
  degreeClass: "L-8 - Ingegneria dell'informazione",
  active: true,
  ...overrides,
})

describe("Politecnico manifesti", () => {
  it("lists a school's courses under their level and regulation", () => {
    const courses = parseCourseList(page("school-auic-2026.html"))
    expect(courses).toContainEqual({
      code: 1030,
      name: "Ingegneria Edile e delle Costruzioni",
      level: "bachelor",
      regulation: "96/23",
    })
    expect(courses).toContainEqual({
      code: 1033,
      name: "Ingegneria Edile - Architettura",
      level: "single-cycle",
      regulation: "96/23",
    })
    expect(courses).toContainEqual({ code: 1015, name: "Architettura", level: "master", regulation: "96/23" })
    // The older regulation's courses stay listed, with their own codes, while their students finish.
    expect(courses).toContainEqual({
      code: 497,
      name: "Ingegneria Edile e delle Costruzioni",
      level: "bachelor",
      regulation: "270",
    })
    expect(new Set(courses.map((c) => c.code)).size).toBe(courses.length)
  })

  it("keeps the campus Polimi adds to a course's name", () => {
    const courses = parseCourseList(page("course-358-2026.html"))
    expect(courses).toContainEqual({
      code: 528,
      name: "Ingegneria Gestionale - CR",
      level: "bachelor",
      regulation: "96/23",
    })
    expect(courses).toContainEqual({
      code: 554,
      name: "Mechanical Engineering - BV,PC",
      level: "master",
      regulation: "96/23",
    })
  })

  it("reads a course page's general information, not the search form's", () => {
    expect(parseAcademicYear(page("course-358-2026.html"))).toBe(2026)
    expect(parseCourseDetails(page("course-358-2026.html"))).toEqual({
      code: 358,
      name: "Ingegneria Informatica",
      school: "3i",
      level: "bachelor",
      campuses: ["Milano Leonardo", "Cremona"],
      languages: ["Italiano"],
      activeYears: [3],
      degreeClass: "L-8 - Ingegneria dell'informazione",
    })
    expect(parseCourseDetails(page("school-auic-2026.html"))).toMatchObject({ code: 1030, school: "auic" })
    expect(parseCourseDetails("<html><body>Nothing here</body></html>")).toBeNull()
  })

  it("recognises the four schools", () => {
    expect(schoolOf("Architettura Urbanistica Ingegneria delle Costruzioni http://www.auic.polimi.it")).toBe("auic")
    expect(schoolOf("Design http://www.design.polimi.it")).toBe("design")
    expect(schoolOf("Ingegneria Industriale e dell'Informazione")).toBe("3i")
    expect(schoolOf("Ingegneria Civile, Ambientale e Territoriale")).toBe("icat")
    expect(() => schoolOf("Scuola di Specializzazione")).toThrow()
  })

  it("collects the codes of a rankings-data manifesti file", () => {
    const url = (code: number) =>
      `https://onlineservices.polimi.it/manifesti/manifesti/controller/MostraIndirizziPublic.do?evn_default=EVENTO&k_corso_la=${code}`
    expect(
      rankingsDataCodes({
        data: {
          "Ingegneria Informatica": { Cremona: url(358), "Milano Leonardo": url(358) },
          "Ingegneria Gestionale": { Cremona: url(368), "Milano Bovisa": url(394) },
        },
      })
    ).toEqual([358, 368, 394])
  })

  it("orders the file stably and reports what changed", () => {
    const old = entry({ code: 358, regulation: "270", activeYears: [2, 3] })
    const sorted = sortCourses([old, entry(), entry({ code: 1030, name: "Ingegneria Edile", school: "auic" })])
    expect(sorted.map((c) => c.code)).toEqual([1030, 531, 358])
    const diff = diffCourseFiles(
      { academicYear: 2025, courses: [old, entry({ code: 999, name: "Gone" })] },
      { academicYear: 2026, courses: [{ ...old, activeYears: [3] }, entry()] }
    )
    expect(diff.added.map((c) => c.code)).toEqual([531])
    expect(diff.removed.map((c) => c.code)).toEqual([999])
    expect(diff.changed).toEqual([{ code: 358, name: "Ingegneria Informatica", fields: ["activeYears"] }])
  })

  it("writes a migration that updates by code and never deletes", () => {
    const sql = coursesMigrationSql({
      academicYear: 2026,
      courses: [entry(), entry({ code: 1094, name: "Progettazione dell'Architettura", languages: [], active: false })],
    })
    expect(sql).toContain(
      "(531, 'Ingegneria Informatica', 'bachelor', '3i', '96/23', array['Milano Leonardo', 'Cremona']"
    )
    expect(sql).toContain("'Progettazione dell''Architettura'")
    expect(sql).toContain("array[]::text[]")
    expect(sql).toContain('ON CONFLICT ("code") DO UPDATE')
    expect(sql).toContain('UPDATE "polimi_courses" SET "active" = false WHERE "code" NOT IN (531, 1094);')
    expect(sql).not.toMatch(/DELETE/i)
  })
})
