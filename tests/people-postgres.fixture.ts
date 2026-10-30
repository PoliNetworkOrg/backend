import assert from "node:assert/strict"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { identities } from "@/db/schema/people"
import { newPerson } from "@/people/model"
import { createPeopleService } from "@/people/service"
import { createPeoplePgStore } from "@/people/store-pg"
import type { Viewer } from "@/people/types"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const databaseName = `people_test_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName })
const db = drizzle({ client, schema })
const checked: string[] = []
try {
  await migrate(db, { migrationsFolder: "./drizzle" })
  const store = createPeoplePgStore(db)
  const permissionSet = new Set(["admin:access", "people:self", "people:read", "people:write", "people:appoint"])
  const viewer = (sub: string): Viewer => ({ sub, telegramId: null, can: (p) => permissionSet.has(p) })
  const hr = viewer("hr")
  const directory = [
    { sub: "mario", name: "Mario Rossi", email: "mario@example.org", telegramId: "101" },
    { sub: "anna", name: "Anna Bianchi", email: "anna@example.org", telegramId: "102" },
    { sub: "luca", name: "Luca Verdi", email: "luca@example.org", telegramId: "103" },
  ]
  const sent: string[] = []
  const people = createPeopleService({
    store,
    dashboardUrl: "https://admin.example.org",
    directory: async () => directory,
    sendMail: async (m) => {
      sent.push(m.id)
    },
  })
  await store.transaction(async ({ state }) => {
    for (const a of directory) {
      const [firstName, lastName] = a.name.split(" ")
      const p = newPerson(
        state,
        {
          firstName,
          lastName,
          personalEmail: a.email,
          phone: "",
          telegramUsername: "",
          course: "Informatica",
          year: "2nd year",
          campus: "Leonardo",
          admin: true,
        },
        "2026-10-01"
      )
      p.profile.telegramId = a.telegramId
    }
  })
  assert.equal((await people.listPeople(hr)).length, 3)
  checked.push("migrations and PostgreSQL metadata round-trip")

  const created = await Promise.all(
    ["Sara", "Paolo"].map((firstName) =>
      people.createPerson(hr, {
        firstName,
        lastName: "Neri",
        personalEmail: `${firstName.toLowerCase()}@example.org`,
        phone: "",
        telegramUsername: "",
        course: "Informatica",
        year: "1st year",
        campus: "Leonardo",
        admin: false,
      })
    )
  )
  assert.deepEqual(created.map((c) => c.id).sort(), ["P-0004", "P-0005"])
  checked.push("concurrent writes are serialized")

  await people.linkAccount(hr, { personId: "P-0001", accountId: "mario", reason: "Checked in person" })
  await assert.rejects(
    people.linkAccount(hr, { personId: "P-0002", accountId: "mario", reason: "Wrong person" }),
    /already linked/
  )
  await people.unlinkAccount(hr, { personId: "P-0001" })
  await people.linkAccount(hr, { personId: "P-0002", accountId: "mario", reason: "Moved" })
  const rows = await db.select().from(identities)
  assert.deepEqual(
    rows.filter((i) => i.accountSub).map((i) => [i.personId, i.accountSub]),
    [["P-0002", "mario"]]
  )
  checked.push("an account moves between records without unique violations")

  await people.sendInvite(hr, { personId: "P-0003" })
  await Promise.all([people.deliverPending(), people.deliverPending()])
  assert.equal(sent.length, 1)
  assert.equal((await people.listInvites(hr))[0].personId, "P-0003")
  checked.push("an invitation is delivered once from the durable outbox")
  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
