import { type SQL, sql } from "drizzle-orm"
import type { PgTableWithColumns, TableConfig } from "drizzle-orm/pg-core"

type ColNames<TC extends TableConfig> = Readonly<(keyof TC["columns"])[]>
type SetSQL<TC extends TableConfig> = Partial<Record<ColNames<TC>[number], SQL<unknown>>>

export function upsertMultipleSetSql<TC extends TableConfig>(
  table: PgTableWithColumns<TC>,
  columnsToUpdate: ColNames<TC>
): SetSQL<TC> {
  return columnsToUpdate.reduce<SetSQL<TC>>((acc, curr) => {
    acc[curr] = sql.raw(`excluded.${table[curr].name}`)
    return acc
  }, {})
}
