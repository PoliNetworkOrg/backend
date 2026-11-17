import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { createAssociationService } from "@/associations/service"
import { createAssociationStore } from "@/associations/store-pg"
import { schema } from "@/db/schema"
import { associationRegistry } from "@/db/schema/web/association-portal"
import { associations } from "@/db/schema/web/associations"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const name = `association_test_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${name}`)
const client = new SQL({ ...connection, database: name })
const db = drizzle({ client, schema })
const folder = await mkdtemp(join(tmpdir(), "association-migrations-"))
try {
  await cp("drizzle", folder, { recursive: true })
  const journalPath = join(folder, "meta/_journal.json")
  const journal = JSON.parse(await readFile(journalPath, "utf8"))
  journal.entries = journal.entries.filter((e: { idx: number }) => e.idx < 40)
  await writeFile(journalPath, JSON.stringify(journal))
  await migrate(db, { migrationsFolder: folder })
  await db.insert(associations).values(
    ["One", "Two", "Messy"].map((name) => ({
      name,
      descriptionIt: "Italiano",
      descriptionEn: "English",
      createdBySub: "legacy",
      telegram: "https://t.me/test",
      ...(name === "Messy"
        ? {
            telegram: "t.me/foo",
            website: "ftp://x.org",
            email: "nope",
            logo: "/relative.png",
            facebook: "https://fb.com/x",
          }
        : {}),
    }))
  )
  await migrate(db, { migrationsFolder: "./drizzle" })
  const store = createAssociationStore(db)
  const service = createAssociationService(store, "https://admin.example.org")
  const staff = { sub: "staff", name: "Staff", operator: true }
  const user = { sub: "new", name: "New", operator: false }
  const migrated = await store.list()
  assert.equal(migrated.length, 3)
  assert.equal(new Set(migrated.map((r) => r.id)).size, 3)
  const messy = migrated.find((r) => r.profile.name === "Messy")!
  assert.equal(messy.profile.logo, null)
  assert.equal(messy.profile.email, "")
  assert.deepEqual(
    messy.profile.links.map((l) => l.url),
    ["https://fb.com/x"]
  )
  assert((await service.get(staff, messy.id)).profile.links.length === 1)
  assert.deepEqual((await store.published()).map((r) => r.legacyId).sort(), [1, 2, 3])
  assert((await store.byInvitation("missing")) === null)
  assert.equal(await store.recentAccessRequests("nobody", new Date(0).toISOString()), 0)
  assert(migrated.every((r) => r.published && r.members.length === 0 && r.legacyId))
  const profile = {
    name: "New",
    acronym: "",
    descriptionIt: "IT",
    descriptionEn: "EN",
    email: "",
    logo: null,
    links: [],
  }
  const commandId = randomUUID()
  const [a, b] = await Promise.all([
    service.create(user, { profile, explanation: "Test", submit: true, commandId }),
    service.create(user, { profile, explanation: "Test", submit: true, commandId }),
  ])
  assert.equal(a.id, b.id)
  const record = await service.get(staff, a.id)
  const review = {
    id: a.id,
    revision: record.revision,
    commandId: randomUUID(),
    action: "review" as const,
    requestId: record.requests[0].id,
    decision: "approve" as const,
    reason: "Verified",
  }
  const results = await Promise.allSettled([
    service.command(staff, review),
    service.command(staff, { ...review, commandId: randomUUID() }),
  ])
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1)
  const current = await service.get(staff, a.id)
  await service.command(user, {
    id: a.id,
    revision: current.revision,
    commandId: randomUUID(),
    action: "save",
    requestId: null,
    profile,
    explanation: "Publish",
  })
  let next = await service.get(staff, a.id)
  await service.command(user, {
    id: a.id,
    revision: next.revision,
    commandId: randomUUID(),
    action: "submit",
    requestId: next.requests.at(-1)!.id,
  })
  next = await service.get(staff, a.id)
  await service.command(staff, {
    id: a.id,
    revision: next.revision,
    commandId: randomUUID(),
    action: "review",
    requestId: next.requests.at(-1)!.id,
    decision: "approve",
    reason: "Approved",
  })
  assert.equal((await db.select().from(associations)).length, 4)
  // A new service instance sees persisted publication, roles and history.
  const restarted = createAssociationService(createAssociationStore(db), "https://admin.example.org")
  const persisted = await restarted.get(user, a.id)
  assert(persisted.published)
  assert.equal(persisted.role, "responsible")
  await restarted.command(staff, {
    id: a.id,
    revision: persisted.revision,
    commandId: randomUUID(),
    action: "unpublish",
    reason: "Hide",
  })
  assert.equal((await restarted.get(user, a.id)).published, false)
  assert.equal((await db.select().from(associationRegistry)).length, 4)
  console.log(
    JSON.stringify({
      checked: [
        "legacy backfill",
        "stable IDs",
        "concurrent create",
        "concurrent review",
        "publication",
        "restart",
        "unpublish without deletion",
      ],
    })
  )
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${name}`)
  await admin.close()
  await rm(folder, { recursive: true, force: true })
}
