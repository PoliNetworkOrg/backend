import { eq, inArray, sql } from "drizzle-orm"
import type { DB } from "@/db"
import { identities, records } from "@/db/schema/people"
import { emptyState, type PeopleState, type PeopleStore } from "./types"

type Database = typeof DB
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
/** Serializes every People transaction. */
const lockPeople = (tx: Transaction) => tx.execute(sql`select pg_advisory_xact_lock(198074, 1)`)

async function loadState(tx: Transaction): Promise<PeopleState> {
  const state = emptyState()
  for (const row of await tx.select().from(records)) {
    const separator = row.id.indexOf(":")
    Object.assign(state[row.kind], { [row.id.slice(separator + 1)]: row.data })
  }
  return state
}

async function saveState(tx: Transaction, state: PeopleState, before: PeopleState) {
  for (const kind of Object.keys(state) as (keyof PeopleState)[]) {
    for (const [id, data] of Object.entries(state[kind])) {
      if (JSON.stringify(data) === JSON.stringify(before[kind][id])) continue
      await tx
        .insert(records)
        .values({ id: `${kind}:${id}`, kind, data })
        .onConflictDoUpdate({ target: records.id, set: { data } })
    }
    for (const id of Object.keys(before[kind])) {
      if (!(id in state[kind])) await tx.delete(records).where(eq(records.id, `${kind}:${id}`))
    }
  }
  // Clear changed and removed unique values first so moving an identity between records is atomic.
  const changed = Object.values(state.persons).filter((p) => JSON.stringify(p) !== JSON.stringify(before.persons[p.id]))
  const removed = Object.keys(before.persons).filter((id) => !(id in state.persons))
  if (changed.length || removed.length)
    await tx.delete(identities).where(inArray(identities.personId, [...changed.map((p) => p.id), ...removed]))
  for (const p of changed)
    await tx.insert(identities).values({
      personId: p.id,
      accountSub: p.accountSub,
      telegramId: p.profile.telegramId,
    })
}

export function createPeoplePgStore(db: Database): PeopleStore {
  return {
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await lockPeople(tx)
        const state = await loadState(tx)
        const before = structuredClone(state)
        const result = await fn({ state })
        await saveState(tx, state, before)
        return result
      }),
  }
}
