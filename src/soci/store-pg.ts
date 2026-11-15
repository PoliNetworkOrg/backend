import { and, asc, desc, eq, inArray, isNull, lt, type SQL } from "drizzle-orm"
import type { DB } from "@/db"
import { activity, fees, files, mail, members, numbers } from "@/db/schema/soci"
import type {
  ActivityEntry,
  FeeChanges,
  NewFee,
  NewMail,
  NewSocio,
  SociMail,
  Socio,
  SocioChanges,
  SociStore,
  StoredFee,
} from "./types"

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

type FeeRow = typeof fees.$inferSelect

function loadFee(r: FeeRow): StoredFee {
  return {
    ...r,
    transferDate: day(r.transferDate),
    paidOn: day(r.paidOn),
    uploadedAt: r.uploadedAt?.toISOString() ?? null,
    reviewedAt: r.reviewedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }
}

const date = <T extends string | null | undefined>(value: T) =>
  (value === undefined ? undefined : value === null ? null : new Date(value)) as T extends string ? Date : T

function saveFee(f: FeeChanges | NewFee): Partial<FeeRow> {
  const { uploadedAt, reviewedAt, updatedAt, ...rest } = f
  const createdAt = (f as Partial<NewFee>).createdAt
  return {
    ...(rest as Omit<Partial<FeeRow>, "createdAt" | "uploadedAt" | "reviewedAt" | "updatedAt">),
    ...(createdAt !== undefined && { createdAt: new Date(createdAt) }),
    ...(uploadedAt !== undefined && { uploadedAt: date(uploadedAt) }),
    ...(reviewedAt !== undefined && { reviewedAt: date(reviewedAt) }),
    updatedAt: new Date(updatedAt),
  }
}

const loadMail = (r: typeof mail.$inferSelect) =>
  ({
    ...r,
    createdAt: r.createdAt.toISOString(),
    attemptedAt: r.attemptedAt?.toISOString() ?? null,
  }) as SociMail

const mailRow = (memberId: number, m: NewMail, at: string) => ({
  ...m,
  memberId,
  status: "pending" as const,
  createdAt: new Date(at),
})

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
    insert: (socio: NewSocio, entry, firstFees = []) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(members)
          .values(save(socio) as Insert)
          .returning()
        await tx.insert(numbers).values({ number: row.number, memberId: row.id, assignedAt: row.createdAt })
        await tx.insert(activity).values(entryRow(row.id, entry))
        if (firstFees.length)
          await tx.insert(fees).values(firstFees.map((f) => ({ ...saveFee(f), memberId: row.id }) as FeeRow))
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

    async fees(filter) {
      const where: SQL[] = []
      if (filter.memberId !== undefined) where.push(eq(fees.memberId, filter.memberId))
      if (filter.year !== undefined) where.push(eq(fees.year, filter.year))
      const rows = await db
        .select()
        .from(fees)
        .where(and(...where))
        .orderBy(desc(fees.year), asc(fees.memberId))
      return rows.map(loadFee)
    },
    openFee: (memberId, fee, entry, outgoing) =>
      db.transaction(async (tx) => {
        const [row] = await tx
          .insert(fees)
          .values({ ...saveFee(fee), memberId } as FeeRow)
          .onConflictDoNothing({ target: [fees.memberId, fees.year] })
          .returning()
        if (!row) return null
        await tx.insert(activity).values(entryRow(memberId, entry))
        if (outgoing)
          await tx
            .insert(mail)
            .values(mailRow(memberId, outgoing, entry.at))
            .onConflictDoNothing()
        return loadFee(row)
      }),
    async updateFee(fee, from, changes, entry, outgoing, file) {
      const unchanged = new Error("unchanged")
      try {
        return await db.transaction(async (tx) => {
          if (file) await tx.insert(files).values({ ...file, uploadedAt: new Date(file.uploadedAt) })
          const where = [eq(fees.id, fee.id), inArray(fees.status, [...from])]
          if (fee.fileId !== undefined)
            where.push(fee.fileId === null ? isNull(fees.fileId) : eq(fees.fileId, fee.fileId))
          const changed = await tx
            .update(fees)
            .set(saveFee(changes))
            .where(and(...where))
            .returning({ id: fees.id })
          // Rolls back the new file too.
          if (!changed.length) throw unchanged
          await tx.insert(activity).values(entryRow(fee.memberId, entry))
          if (outgoing)
            await tx
              .insert(mail)
              .values(mailRow(fee.memberId, outgoing, entry.at))
              .onConflictDoNothing()
          return true
        })
      } catch (error) {
        if (error === unchanged) return false
        throw error
      }
    },
    async file(id) {
      const [row] = await db.select().from(files).where(eq(files.id, id))
      return row ? { ...row, uploadedAt: row.uploadedAt.toISOString() } : null
    },
    async fileNames(ids) {
      if (!ids.length) return new Map()
      const rows = await db
        .select({ id: files.id, fileName: files.fileName, contentType: files.contentType })
        .from(files)
        .where(inArray(files.id, ids))
      return new Map(rows.map((r) => [r.id, { fileName: r.fileName, contentType: r.contentType }]))
    },

    async enqueue(memberId, outgoing, at) {
      const rows = await db
        .insert(mail)
        .values(mailRow(memberId, outgoing, at))
        .onConflictDoNothing()
        .returning({ id: mail.id })
      return rows.length > 0
    },
    claimMail: (at, staleBefore, limit) =>
      db.transaction(async (tx) => {
        await tx
          .update(mail)
          .set({ status: "failed", error: "Delivery outcome unknown after an interruption: check before resending." })
          .where(and(eq(mail.status, "sending"), lt(mail.attemptedAt, new Date(staleBefore))))
        const pending = await tx
          .select({ id: mail.id })
          .from(mail)
          .where(eq(mail.status, "pending"))
          .orderBy(asc(mail.createdAt), asc(mail.id))
          .limit(limit)
          .for("update", { skipLocked: true })
        if (!pending.length) return []
        const rows = await tx
          .update(mail)
          .set({ status: "sending", attemptedAt: new Date(at), error: null })
          .where(
            and(
              inArray(
                mail.id,
                pending.map((p) => p.id)
              ),
              eq(mail.status, "pending")
            )
          )
          .returning()
        return rows.map(loadMail)
      }),
    finishMail: (sent, error, at) =>
      db.transaction(async (tx) => {
        const changed = await tx
          .update(mail)
          .set({ status: error ? "failed" : "sent", error })
          .where(
            and(eq(mail.id, sent.id), eq(mail.status, "sending"), eq(mail.attemptedAt, new Date(sent.attemptedAt ?? 0)))
          )
          .returning({ id: mail.id })
        if (changed.length)
          await tx.insert(activity).values(
            entryRow(sent.memberId, {
              actor: "system",
              text: error ? `The ${sent.kind} email failed: ${error}` : `Sent the ${sent.kind} email`,
              at,
            })
          )
      }),
  }
}
