import { sql } from "drizzle-orm"
import { boolean, check, integer, text } from "drizzle-orm/pg-core"
import { createTable } from "../create-table"

/**
 * Politecnico's degree courses, from the official manifesti. Loaded by hand once a year from a reviewed file
 * (`scripts/polimi-courses/`); never deleted, since People records point to them: a course no longer offered becomes
 * inactive.
 */
export const courses = createTable.polimi(
  "courses",
  {
    /** Polimi's own course code (`k_corso_la`). */
    code: integer().primaryKey(),
    name: text().notNull(),
    level: text().$type<"bachelor" | "master" | "single-cycle">().notNull(),
    school: text().$type<"auic" | "icat" | "3i" | "design">().notNull(),
    /** "96/23" or "270". */
    regulation: text().notNull(),
    campuses: text().array().notNull().default(sql`'{}'::text[]`),
    languages: text().array().notNull().default(sql`'{}'::text[]`),
    /** The years of the course still taught, in the last academic year that offered it. */
    activeYears: integer("active_years").array().notNull().default(sql`'{}'::integer[]`),
    degreeClass: text("degree_class").notNull().default(""),
    active: boolean().notNull(),
    /** The academic year (its first calendar year) of the file that last updated it. */
    academicYear: integer("academic_year").notNull(),
  },
  (t) => [
    check("polimi_courses_level_check", sql`${t.level} in ('bachelor', 'master', 'single-cycle')`),
    check("polimi_courses_school_check", sql`${t.school} in ('auic', 'icat', '3i', 'design')`),
  ]
)

export const schema = { polimiCourses: courses }
