import assert from "node:assert/strict"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { mail, members } from "@/db/schema/soci"
import { createSociPgStore } from "@/soci/store-pg"
import type { NewSocio } from "@/soci/types"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const databaseName = `soci_test_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName })
const db = drizzle({ client, schema })
const checked: string[] = []
const at = "2026-11-09T10:00:00.000Z"
const entry = (text: string) => ({ actor: "usr_direttivo", text, at })
const socio = (number: number, entraObjectId: string, codiceFiscale: string | null): NewSocio => ({
  number,
  entraObjectId,
  mailbox: `${entraObjectId}@polinetwork.org`,
  displayName: entraObjectId,
  firstName: "Mario",
  lastName: "Rossi",
  alias: null,
  codiceFiscale,
  birthDate: "1980-01-01",
  birthPlace: "Roma",
  residence: "Via Roma 1, 20133 Milano (MI)",
  phone: "+393331234567",
  admittedOn: "2026-11-09",
  endedOn: null,
  endReason: null,
  endNote: null,
  accountState: "active",
  accountDeletedOn: null,
  createdBy: "usr_direttivo",
  createdAt: at,
  updatedBy: "usr_direttivo",
  updatedAt: at,
})
try {
  await migrate(db, { migrationsFolder: "./drizzle" })
  const store = createSociPgStore(db)

  const mario = await store.insert(socio(344, "oid-mario", "RSSMRA80A01H501U"), entry("Admitted"))
  const loaded = await store.byNumber(344)
  assert.deepEqual(loaded, { ...socio(344, "oid-mario", "RSSMRA80A01H501U"), id: mario.id })
  assert.equal(await store.numberOwner(344), mario.id)
  assert.deepEqual(await store.activity(mario.id), [entry("Admitted")])
  checked.push("a record, its number and its history round-trip, dates included")

  await assert.rejects(store.insert(socio(345, "oid-other", "RSSMRA80A01H501U"), entry("Admitted")))
  await assert.rejects(store.insert(socio(344, "oid-other", null), entry("Admitted")))
  await assert.rejects(store.insert(socio(345, "oid-mario", null), entry("Admitted")))
  assert.equal((await store.list()).length, 1)
  checked.push("one active record per codice fiscale, number and account")

  await store.changeNumber(mario.id, 350, entry("Number changed"))
  assert.equal((await store.byNumber(350))?.id, mario.id)
  assert.equal(await store.numberOwner(344), mario.id)
  // No record may take 344, even though nobody holds it now.
  await assert.rejects(store.insert(socio(344, "oid-anna", null), entry("Admitted")))
  await store.changeNumber(mario.id, 344, entry("Number changed back"))
  assert.equal((await store.byNumber(344))?.id, mario.id)
  checked.push("a number once held is never given to another record")

  await store.update(
    mario.id,
    { endedOn: "2026-12-31", endReason: "resigned", updatedBy: "usr_direttivo", updatedAt: at },
    entry("Ended")
  )
  const readmitted = await store.insert(socio(351, "oid-mario-2", "RSSMRA80A01H501U"), entry("Admitted"))
  assert.equal((await store.activeByCodiceFiscale("RSSMRA80A01H501U"))?.id, readmitted.id)
  await assert.rejects(
    db.insert(members).values({
      ...socio(352, "oid-x", null),
      residence: null,
      endedOn: "2026-12-31",
      createdAt: new Date(at),
      updatedAt: new Date(at),
    } as never)
  )
  checked.push("an ended record frees its code for a re-admission, and an end needs its reason")

  const blank = {
    fileId: null,
    transferDate: null,
    declaredCents: null,
    uploadedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    rejectionReason: null,
    paidOn: null,
    method: null,
    note: null,
    recordedBy: null,
  }
  const due = { ...blank, year: 2026, status: "due" as const, amountCents: 500, createdAt: at, updatedAt: at }
  const outgoing = (id: string) => ({
    id,
    to: "mario@polinetwork.org",
    kind: "opening" as const,
    data: { name: "Mario" } as never,
  })
  const fee = await store.openFee(readmitted.id, due, entry("Opened"), outgoing("opening:2026:x"))
  assert.ok(fee)
  assert.equal(await store.openFee(readmitted.id, due, entry("Opened again"), outgoing("opening:2026:y")), null)
  const fileId = "5f0c6a2e-8a1b-4c2d-9e3f-0a1b2c3d4e5f"
  const file = {
    id: fileId,
    memberId: readmitted.id,
    fileName: "r.pdf",
    contentType: "application/pdf",
    content: new Uint8Array([37, 80, 68, 70]),
    uploadedBy: "usr_mario",
    uploadedAt: at,
  }
  // An upload without its file is refused by the table.
  await assert.rejects(store.updateFee(fee, ["due"], { status: "uploaded", updatedAt: at }, entry("Bad upload")))
  const upload = {
    status: "uploaded" as const,
    fileId,
    transferDate: "2026-11-09",
    declaredCents: 500,
    uploadedAt: at,
    updatedAt: at,
  }
  // A fee that changed in the meantime keeps its state, and the new file is rolled back with it.
  assert.equal(await store.updateFee(fee, ["paid"], upload, entry("Uploaded"), undefined, file), false)
  assert.equal(await store.file(fileId), null)
  assert.equal(await store.updateFee(fee, ["due"], upload, entry("Uploaded"), undefined, file), true)
  assert.equal(await store.updateFee(fee, ["due"], upload, entry("Uploaded twice")), false)
  // A review applies only while the fee still holds the reviewed file.
  const otherFile = { ...fee, fileId: "00000000-0000-4000-8000-000000000000" }
  assert.equal(await store.updateFee(otherFile, ["uploaded"], { status: "due", updatedAt: at }, entry("No")), false)
  const [loadedFee] = await store.fees({ memberId: readmitted.id })
  assert.deepEqual({ ...loadedFee }, { ...fee, ...upload, id: fee.id, memberId: readmitted.id })
  assert.deepEqual((await store.file(fileId))?.content, new Uint8Array([37, 80, 68, 70]))
  assert.deepEqual(
    [...(await store.fileNames([fileId])).values()],
    [{ fileName: "r.pdf", contentType: "application/pdf" }]
  )
  const paid = {
    ...blank,
    year: 2025,
    status: "paid" as const,
    amountCents: 500,
    paidOn: "2025-10-01",
    method: "admission" as const,
    recordedBy: "usr_direttivo",
    createdAt: at,
    updatedAt: at,
  }
  const admitted = await store.insert(socio(360, "oid-anna", null), entry("Admitted"), [paid])
  assert.deepEqual(
    (await store.fees({ memberId: admitted.id })).map(({ id: _, memberId: __, ...f }) => f),
    [paid]
  )
  checked.push("a fee opens once per year, changes only from the expected status, and keeps its receipt")

  assert.equal(await store.enqueue(readmitted.id, outgoing("opening:2026:x"), at), false)
  assert.equal(await store.enqueue(readmitted.id, outgoing("reminder:2026:dec-1:x"), at), true)
  const claimed = await store.claimMail(at, at, 10)
  assert.deepEqual(claimed.map((m) => m.id).sort(), ["opening:2026:x", "reminder:2026:dec-1:x"])
  assert.deepEqual(await store.claimMail(at, at, 10), [])
  await store.finishMail(claimed[0], null, at)
  // Still `sending` an hour later: the outcome is unknown, so it fails rather than sending twice.
  assert.deepEqual(await store.claimMail("2026-11-09T11:00:01.000Z", "2026-11-09T10:50:00.000Z", 10), [])
  const statuses = await db.select({ id: mail.id, status: mail.status }).from(mail).orderBy(mail.id)
  assert.deepEqual(
    statuses.map((m) => m.status),
    claimed[0].id === statuses[0].id ? ["sent", "failed"] : ["failed", "sent"]
  )
  checked.push("an email is queued once per key, claimed once, and fails when its outcome is unknown")
  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
