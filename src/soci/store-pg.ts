import { and, asc, desc, eq, isNull } from "drizzle-orm"
import type { DB } from "@/db"
import { activity, members, numbers } from "@/db/schema/soci"
import type { ActivityEntry, NewSocio, Socio, SocioChanges, SociStore } from "./types"

type Database = typeof DB
type Row = typeof members.$inferSelect
type Insert = typeof members.$inferInsert

/** Bun's driver returns `date` columns as a `Date` at UTC midnight, whatever the column's mode. */
const day = <T extends string | null>(value: T | Date): T =>
  (value instanceof Date ? value.toISOString().slice(0, 10) : value) as T

function load(r: Row): Socio {
  return {
    id: r.id,
    number: r.number,
    entraObjectId: r.entraObjectId,
    mailbox: r.mailbox,
    displayName: r.displayName,
    firstName: r.firstName,
    lastName: r.lastName,
    alias: r.alias,
    codiceFiscale: r.codiceFiscale,
    birthDate: day(r.birthDate),
    birthPlace: r.birthPlace,
    residence: r.residence,
    phone: r.phone,
    admittedOn: day(r.admittedOn),
    endedOn: day(r.endedOn),
    endReason: r.endReason,
    endNote: r.endNote,
    accountState: r.accountState,
    accountDeletedOn: day(r.accountDeletedOn),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedBy: r.updatedBy,
    updatedAt: r.updatedAt.toISOString(),
  }
}

function save(s: SocioChanges): Partial<Insert> {
  const { createdAt, updatedAt, ...rest } = s as SocioChanges & { createdAt?: string }
  return {
    ...rest,
    ...(createdAt && { createdAt: new Date(createdAt) }),
    updatedAt: new Date(updatedAt),
  }
}

const entryRow = (memberId: number, e: ActivityEntry) => ({
  memberId,
  actor: e.actor,
  text: e.text,
  at: new Date(e.at),
})

export function createSociPgStore(db: Database): SociStore {
  const first = (rows: Row[]) => (rows[0] ? load(rows[0]) : null)
  return {
    async list() {
      return (await db.select().from(members).orderBy(asc(members.number))).map(load)
    },
    async byNumber(number) {
      return first(await db.select().from(members).where(eq(members.number, number)))
    },
    async byObjectId(entraObjectId) {
      return first(await db.select().from(members).where(eq(members.entraObjectId, entraObjectId)))
    },
    async activeByCodiceFiscale(codiceFiscale) {
      return first(
        await db
          .select()
          .from(members)
          .where(and(eq(members.codiceFiscale, codiceFiscale), isNull(members.endedOn)))
      )
    },
    async numberOwner(number) {
      const [row] = await db.select({ memberId: numbers.memberId }).from(numbers).where(eq(numbers.number, number))
      return row?.memberId ?? null
    },
    async activity(memberId) {
      const rows = await db.select().from(activity).where(eq(activity.memberId, memberId)).orderBy(desc(activity.id))
      return rows.map((r) => ({ actor: r.actor, text: r.text, at: r.at.toISOString() }))
    },
    insert: (socio: NewSocio, entry) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(members)
          .values(save(socio) as Insert)
          .returning()
        await tx.insert(numbers).values({ number: row.number, memberId: row.id, assignedAt: row.createdAt })
        await tx.insert(activity).values(entryRow(row.id, entry))
        return load(row)
      }),
    update: (memberId, changes, entry) =>
      db.transaction(async (tx) => {
        await tx.update(members).set(save(changes)).where(eq(members.id, memberId))
        await tx.insert(activity).values(entryRow(memberId, entry))
      }),
    changeNumber: (memberId, number, entry) =>
      db.transaction(async (tx) => {
        const at = new Date(entry.at)
        // Going back to a number this record held before keeps its original row.
        const [held] = await tx.select().from(numbers).where(eq(numbers.number, number))
        if (held && held.memberId !== memberId) throw new Error(`Member number ${number} was given to another record`)
        if (!held) await tx.insert(numbers).values({ number, memberId, assignedAt: at })
        await tx.update(members).set({ number, updatedBy: entry.actor, updatedAt: at }).where(eq(members.id, memberId))
        await tx.insert(activity).values(entryRow(memberId, entry))
      }),
  }
}
