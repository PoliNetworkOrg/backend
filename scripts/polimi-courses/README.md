# Politecnico courses

The `polimi_courses` table holds Politecnico's degree courses, which People records point to (a person's course, and
through it their school and the CCS or school a student representative sits on). It is reference data, updated by hand
once a year, after Polimi publishes the next academic year's manifesti (usually in spring).

Our format is our own: the script reads the sources and writes a reviewed JSON file in `data/`, and a migration loads
it. Nothing else depends on the sources' formats.

## Sources

1. **Polimi's manifesti** (`onlineservices.polimi.it/manifesti`), the official list. For each school (AUIC, Design,
   ICAT, 3I) the search form lists every course of the academic year with its code (`k_corso_la`), level and
   regulation, and each course's page names its school, campuses, languages, active years and degree class.
2. **[PoliNetworkOrg/rankings-data](https://github.com/PoliNetworkOrg/rankings-data)**
   (`data/output/manifesti/all.json`): the courses the Rankings project scraped, by name, campus and manifesto link.
   Its codes that the year no longer offers are kept, inactive, with the details of the last year that offered them.

## Things to know

- **Two regulations.** Polimi moved its courses to a new regulation (D.M. 96/23, shown as `96/23`) with new codes. The
  older courses (`270`) stay listed, with their own codes, until their students finish: Ingegneria Informatica is 531
  (`96/23`) and 358 (`270`). Both are separate courses here; a person picks the one they're enrolled in.
- **Campuses.** One code can run on several campuses (Ingegneria Informatica: Milano Leonardo and Cremona); others
  have a code per campus, and their names say which (Ingegneria Gestionale - CR, Ingegneria Gestionale - BV).
- **Never deleted.** A course the year no longer offers stays in the file and the table with `active: false`, since
  records may point to it. The dashboard only offers active courses for new choices.
- **Study plans aren't courses.** Ingegneria Informatica Online (IOL) is a study plan of Ingegneria Informatica.

## Yearly update

```sh
# 1. Build the year's file (about two minutes: one request at a time, with pauses)
bun scripts/polimi-courses/fetch.ts --year 2027

# 2. Review the summary it prints (added, removed, changed courses since last year) and the file's diff.

# 3. Create an empty migration and fill it from the file
bunx drizzle-kit generate --custom --name polimi_courses_2027_28   # needs the usual DB_* and ENCRYPTION_KEY env
bun scripts/polimi-courses/sql.ts scripts/polimi-courses/data/2027-28.json drizzle/00xx_polimi_courses_2027_28.sql
```

Open a pull request with the file and the migration. The migration inserts new courses, updates existing ones by code
and marks inactive every course the file doesn't list.

`fetch.ts` exits with status 1 and lists the problems when a listed course's page can't be read, or a rankings-data
code can't be found in any academic year since 2021.
