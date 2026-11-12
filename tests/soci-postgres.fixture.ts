import assert from "node:assert/strict"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { members } from "@/db/schema/soci"
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
  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
