import assert from "node:assert/strict"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { assignments, persons } from "@/db/schema/people"
import { createPeopleService } from "@/people/service"
import { createPeoplePgStore } from "@/people/store-pg"
import type { Viewer } from "@/people/types"
import { fakeAuth } from "./people-auth"

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
  const viewer = (sub: string): Viewer => ({
    sub,
    telegramId: null,
    can: (p) => permissionSet.has(p),
    holdsRole: () => false,
  })
  const hr = viewer("hr")
  const directory = [
    { sub: "mario", name: "Mario Rossi", email: "mario@example.org" },
    { sub: "anna", name: "Anna Bianchi", email: "anna@example.org" },
  ]
  const auth = fakeAuth()
  const sent: string[] = []
  /** A new service reads Auth again instead of its cached answer. */
  const service = () =>
    createPeopleService({
      store,
      dashboardUrl: "https://admin.example.org",
      directory: async () => directory,
      peopleRoles: auth.auth,
      sendMail: async (m) => {
        sent.push(m.id)
      },
    })
  const people = service()
  const input = (firstName: string) => ({
    firstName,
    lastName: "Neri",
    contactEmail: `${firstName.toLowerCase()}@example.org`,
    phone: "",
    telegramUsername: "",
  })

  const created = await Promise.all(["Sara", "Paolo", "Luca"].map((name) => people.createPerson(hr, input(name))))
  assert.deepEqual(created.map((c) => c.id).sort(), ["P-0001", "P-0002", "P-0003"])
  checked.push("concurrent writes are serialized")

  await people.assignAdmin(hr, { personId: "P-0001", since: "2026-10-01", capoId: null })
  await people.linkAccount(hr, { personId: "P-0001", accountId: "mario", reason: "Checked in person" })
  assert.deepEqual(auth.held("mario"), ["admin"])
  await people.appointCapo(hr, { personId: "P-0001", since: "2026-10-01", scope: "Ingegneria Informatica" })
  await people.assignAdmin(hr, { personId: "P-0002", since: "2026-10-01", capoId: "P-0001" })
  const record = await people.getPerson(hr, { id: "P-0001" })
  assert.deepEqual(
    record.assignments.map((a) => [a.kind, a.status, a.endedOn]),
    [
      ["admin", "applied", null],
      ["capo", "applied", null],
    ]
  )
  assert.equal(
    record.activity[0].text,
    "PoliNetwork Auth confirmed: Appointed Capo Admin from People (Ingegneria Informatica)"
  )
  assert.equal((await people.listCapos(hr))[0].admins[0].id, "P-0002")
  checked.push("assignments, role commands and the Capo relation round-trip")

  // Changing a team role in Auth ends one assignment and starts another for the same concept in one transaction.
  auth.give("anna", "it-member", "Anna Bianchi")
  assert.equal((await service().listPeople(hr)).length, 4)
  auth.take("anna", "it-member")
  auth.give("anna", "it-lead")
  const anna = (await service().listPeople(hr)).find((p) => p.account.status === "linked" && p.account.sub === "anna")
  assert.deepEqual(
    anna?.assignments.map((a) => [a.teamRole, a.endedOn === null]),
    [
      ["member", false],
      ["lead", true],
    ]
  )
  checked.push("a record is created for a role given in Auth, and follows it")

  // Linking HR's record to that account folds the automatic one into it, in one transaction.
  const automaticId = anna?.id as string
  const { id: hrAnna } = await people.createPerson(hr, input("Anna"))
  await people.addTeamMember(hr, { teamId: "it", personId: hrAnna, role: "lead", since: "2026-10-01", fields: {} })
  await service().linkAccount(hr, { personId: hrAnna, accountId: "anna", reason: "Same person" })
  const absorbed = await service().getPerson(hr, { id: hrAnna })
  assert.equal(absorbed.assignments.filter((a) => !a.endedOn).length, 1)
  assert.ok(absorbed.activity.some((a) => a.text === "Created from a role held in PoliNetwork Auth"))
  assert.equal((await db.select().from(persons).where(eq(persons.id, automaticId))).length, 0)
  checked.push("an automatic record is absorbed by the record linked to its account")

  await assert.rejects(
    people.linkAccount(hr, { personId: "P-0003", accountId: "mario", reason: "Wrong person" }),
    /already linked/
  )
  await assert.rejects(
    db.insert(assignments).values({
      id: crypto.randomUUID(),
      personId: "P-0001",
      kind: "admin",
      since: "2026-10-01",
      assignedBy: "x",
      change: "start",
      status: "applied",
    })
  )
  const [{ count }] = await client`select count(*)::int as count from people_persons where account_sub = 'mario'`
  assert.equal(count, 1)
  assert.equal((await db.select().from(persons)).length, 4)
  checked.push("constraints hold one account and one current assignment per concept")

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
