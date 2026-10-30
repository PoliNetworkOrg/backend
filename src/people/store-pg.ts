import { desc, eq, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"
import type { DB } from "@/db"
import { activity, assignments, counters, invites, mail, persons, roleCommands } from "@/db/schema/people"
import { emptyState, type PeopleState, type PeopleStore, type UnitOfWork } from "./types"

type Database = typeof DB
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
/** Serializes People writes: the register is small, and syncing with Auth writes across records. */
const lockPeople = (tx: Transaction) => tx.execute(sql`select pg_advisory_xact_lock(198074, 1)`)

const iso = (value: Date | null) => value?.toISOString() ?? null
const time = (value: string | null) => (value ? new Date(value) : null)
/** Bun's driver returns `date` columns as a `Date` at UTC midnight, whatever the column's mode. */
const day = (value: string | Date | null) => (value instanceof Date ? value.toISOString().slice(0, 10) : value)

/** How each collection of the state maps to its table, in an order that satisfies the foreign keys. */
const TABLES = [
  {
    kind: "persons",
    table: persons,
    id: persons.id,
    load: (r: typeof persons.$inferSelect) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    }),
    save: (p: PeopleState["persons"][string]) => ({
      ...p,
      createdAt: new Date(p.createdAt),
      updatedAt: new Date(p.updatedAt),
    }),
  },
  {
    kind: "commands",
    table: roleCommands,
    id: roleCommands.id,
    load: (r: typeof roleCommands.$inferSelect) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
      answeredAt: iso(r.answeredAt),
    }),
    save: (c: PeopleState["commands"][string]) => ({
      ...c,
      createdAt: new Date(c.createdAt),
      answeredAt: time(c.answeredAt),
    }),
  },
  {
    kind: "assignments",
    table: assignments,
    id: assignments.id,
    load: (r: typeof assignments.$inferSelect) => ({
      ...r,
      team: r.team as PeopleState["assignments"][string]["team"],
      since: day(r.since) as string,
      endedOn: day(r.endedOn),
    }),
    save: (a: PeopleState["assignments"][string]) => a,
  },
  {
    kind: "invites",
    table: invites,
    id: invites.id,
    load: (r: typeof invites.$inferSelect) => ({
      ...r,
      sentAt: r.sentAt.toISOString(),
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: iso(r.revokedAt),
      acceptedAt: iso(r.acceptedAt),
    }),
    save: (i: PeopleState["invites"][string]) => ({
      ...i,
      sentAt: new Date(i.sentAt),
      expiresAt: new Date(i.expiresAt),
      revokedAt: time(i.revokedAt),
      acceptedAt: time(i.acceptedAt),
    }),
  },
  {
    kind: "mail",
    table: mail,
    id: mail.id,
    load: (r: typeof mail.$inferSelect) => ({ ...r, attemptedAt: iso(r.attemptedAt) }),
    save: (m: PeopleState["mail"][string]) => ({ ...m, attemptedAt: time(m.attemptedAt) }),
  },
] as const

async function loadState(tx: Transaction): Promise<PeopleState> {
  const state = emptyState()
  for (const { kind, table, load } of TABLES) {
    const rows = (await tx.select().from(table as PgTable)) as Parameters<typeof load>[0][]
    for (const r of rows) Object.assign(state[kind], { [r.id]: (load as (r: unknown) => unknown)(r) })
  }
  for (const r of await tx.select().from(counters)) state.counters[r.key] = r.value
  return state
}

const ends = (value: unknown, previous: unknown) =>
  !!(value as { endedOn?: string | null }).endedOn && !(previous as { endedOn?: string | null }).endedOn

/**
 * Writes what the transaction changed. Rows are never deleted, except records merged into another (`merges`),
 * once everything of theirs has moved.
 */
async function saveState(tx: Transaction, uow: UnitOfWork, before: PeopleState) {
  const { state, merges } = uow
  const merged = new Set(merges.map((m) => m.from))
  // Free the merged records' accounts before another record takes them.
  for (const { from } of merges) await tx.update(persons).set({ accountSub: null }).where(eq(persons.id, from))
  for (const { kind, table, id, save } of TABLES) {
    const changed = Object.entries(state[kind]).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(before[kind][key])
    )
    // Rows that end first, then other updates, then new rows: an assignment frees its concept before another
    // takes it, whether it is new or moves over from a merged record.
    const existing = changed
      .filter(([key]) => key in before[kind])
      .sort(([a, x], [b, y]) => Number(ends(y, before[kind][b])) - Number(ends(x, before[kind][a])))
    for (const [key, value] of existing)
      await tx
        .update(table)
        .set((save as (v: unknown) => Record<string, unknown>)(value))
        .where(eq(id, key))
    const added = changed.filter(([key]) => !(key in before[kind])).map(([, v]) => (save as (v: unknown) => object)(v))
    if (added.length) await tx.insert(table).values(added as never)
    const removed = Object.keys(before[kind]).filter((key) => !(key in state[kind]))
    if (removed.some((key) => kind !== "persons" || !merged.has(key)))
      throw new Error(`People never deletes ${kind}: ${removed.join(", ")}`)
  }
  for (const [key, value] of Object.entries(state.counters))
    if (before.counters[key] !== value)
      await tx.insert(counters).values({ key, value }).onConflictDoUpdate({ target: counters.key, set: { value } })
  // A record merged in this transaction may never have been saved: its new entries go straight to `into`.
  const mergedInto = new Map(merges.map((m) => [m.from, m.into]))
  const survivor = (personId: string): string =>
    mergedInto.has(personId) ? survivor(mergedInto.get(personId) as string) : personId
  if (uow.activity.length)
    await tx
      .insert(activity)
      .values(uow.activity.map((entry) => ({ ...entry, personId: survivor(entry.personId), at: new Date(entry.at) })))
  for (const { from, into } of merges) {
    await tx.update(activity).set({ personId: into }).where(eq(activity.personId, from))
    await tx.delete(persons).where(eq(persons.id, from))
  }
}

export function createPeoplePgStore(db: Database): PeopleStore {
  return {
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await lockPeople(tx)
        const state = await loadState(tx)
        const before = structuredClone(state)
        const uow: UnitOfWork = { state, activity: [], merges: [] }
        const result = await fn(uow)
        await saveState(tx, uow, before)
        return result
      }),
    async activity(personId) {
      const rows = await db.select().from(activity).where(eq(activity.personId, personId)).orderBy(desc(activity.id))
      return rows.map((r) => ({ personId: r.personId, actor: r.actor, text: r.text, at: r.at.toISOString() }))
    },
  }
}
