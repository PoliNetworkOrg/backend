import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { createEventService } from "@/associations/events"
import { createEventStore } from "@/associations/events-pg"
import { createPromotionService } from "@/associations/promotions"
import { createPromotionStore } from "@/associations/promotions-pg"
import { publicAssociations, publicEvents } from "@/associations/public"
import { createAssociationService } from "@/associations/service"
import { createAssociationStore } from "@/associations/store-pg"
import { schema } from "@/db/schema"
import { groupLabels } from "@/db/schema/common/group-labels"
import {
  associationCatalogue,
  associationEvent,
  associationEventTransition,
  associationMail,
  associationPromotion,
  associationPromotionTransition,
  associationRegistry,
} from "@/db/schema/web/association-portal"
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
  // Simulate a record written by the first release, which stored the state as a jsonb string.
  journal.entries = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8")).entries.filter(
    (e: { idx: number }) => e.idx < 41
  )
  await writeFile(journalPath, JSON.stringify(journal))
  await migrate(db, { migrationsFolder: folder })
  await client.unsafe(
    `UPDATE web_association_registry SET state = to_jsonb(state::text) WHERE id = (SELECT min(id::text)::uuid FROM web_association_registry)`
  )
  await db
    .insert(groupLabels)
    .values(
      [
        "didattica.design.triennale.design-della-moda.25-26",
        "didattica.design.triennale.design-della-moda.26-27",
        "didattica.design",
        "ita",
        "bovisa",
        "extra.affitti",
      ].map((label) => ({ label, createdBySub: "legacy" }))
    )
  await migrate(db, { migrationsFolder: "./drizzle" })
  // 0042: one programme per course across cohorts, the six campuses, and backfilled JSON on every record.
  const catalogueRows = await db.select().from(associationCatalogue)
  assert.deepEqual(
    catalogueRows.filter((e) => e.kind === "programme").map((e) => [e.slug, e.nameIt, e.nameEn]),
    [["didattica.design.triennale.design-della-moda", "Design Della Moda (triennale)", "Design Della Moda (bachelor)"]]
  )
  assert.deepEqual(
    catalogueRows
      .filter((e) => e.kind === "campus")
      .map((e) => e.slug)
      .sort(),
    ["bovisa", "cremona", "lecco", "leonardo", "mantova", "piacenza"]
  )
  for (const row of await db.select().from(associationRegistry)) {
    assert.deepEqual(row.state.contacts, [])
    for (const p of [row.state.profile, row.state.published])
      assert.deepEqual([p?.programmes, p?.campuses, p?.crossProgramme, p?.contacts], [[], [], false, []])
  }
  const objects = async () =>
    (await client.unsafe(`SELECT DISTINCT jsonb_typeof(state) AS t FROM web_association_registry`)).map(
      (r: { t: string }) => r.t
    )
  assert.deepEqual(await objects(), ["object"])
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
    programmes: [],
    campuses: ["leonardo"],
    crossProgramme: false,
    contacts: [],
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
  // App-written rows are jsonb objects, so JSON lookups (invitations, publication) find them.
  const invited = await service.get(user, a.id)
  await service.command(user, {
    id: a.id,
    revision: invited.revision,
    commandId: randomUUID(),
    action: "invite",
    email: "invitee@example.org",
    role: "collaborator",
    explanation: "Board member",
  })
  const [invite] = await db.select().from(associationMail)
  const token = new URL(invite.mail.text.split("\n").at(-1) ?? "").searchParams.get("token") ?? ""
  assert.equal((await service.invitation(token)).associationName, "New")
  assert.deepEqual(await objects(), ["object"])
  assert((await store.published()).some((r) => r.id === a.id))
  // Contacts: the public one goes through review, the others are saved at once and never reach the website.
  const contact = (visibility: "public" | "associations" | "polinetwork") => ({
    id: randomUUID(),
    function: "events" as const,
    label: visibility,
    email: `${visibility}@example.org`,
    name: visibility === "polinetwork" ? "Personal Name" : "",
    phone: "",
    visibility,
    holderSub: null,
  })
  let latest = await service.get(user, a.id)
  await service.command(user, {
    id: a.id,
    revision: latest.revision,
    commandId: randomUUID(),
    action: "contacts",
    contacts: [contact("public"), contact("associations"), contact("polinetwork")],
  })
  latest = await service.get(user, a.id)
  const contactDraft = latest.requests.filter((q) => q.kind === "content").at(-1)
  assert(contactDraft?.status === "draft")
  await service.command(user, {
    id: a.id,
    revision: latest.revision,
    commandId: randomUUID(),
    action: "submit",
    requestId: contactDraft.id,
  })
  latest = await service.get(staff, a.id)
  await service.command(staff, {
    id: a.id,
    revision: latest.revision,
    commandId: randomUUID(),
    action: "review",
    requestId: contactDraft.id,
    decision: "approve",
    reason: "OK",
  })
  const site = (await publicAssociations(store)).find((p) => p.name === "New")
  assert.deepEqual(site?.campuses, [{ slug: "leonardo", nameIt: "Milano Leonardo", nameEn: "Milan Leonardo" }])
  assert.deepEqual(
    site?.contacts?.map((c) => c.label),
    ["public"]
  )
  assert.equal(JSON.stringify(await publicAssociations(store)).includes("Personal Name"), false)
  // Promotion requests: concurrent decisions, retried commands, append-only transitions and the SQL queue.
  const promotions = createPromotionService(createPromotionStore(db), store, "https://admin.example.org")
  const userWithMail = { ...user, email: "new@example.org" }
  const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
  const promotionContent = {
    title: "Evento",
    text: "Testo",
    link: "",
    poster: null,
    channels: [{ channel: "poliassociazioni" as const, programme: null, note: "" }],
    audience: { everyone: true, programmes: [], campuses: [] },
    desiredDate: day,
    deadline: null,
    eventId: null,
  }
  const createKey = randomUUID()
  const [p1, p2] = await Promise.all([
    promotions.create(userWithMail, { associationId: a.id, content: promotionContent, commandId: createKey }),
    promotions.create(userWithMail, { associationId: a.id, content: promotionContent, commandId: createKey }),
  ])
  assert.equal(p1.id, p2.id)
  assert.equal((await db.select().from(associationPromotion)).length, 1)
  const submitKey = randomUUID()
  await Promise.all([
    promotions.command(userWithMail, { id: p1.id, revision: 0, commandId: submitKey, action: "submit" }),
    promotions.command(userWithMail, { id: p1.id, revision: 0, commandId: submitKey, action: "submit" }),
  ])
  const decisions = await Promise.allSettled([
    promotions.command(staff, { id: p1.id, revision: 1, commandId: randomUUID(), action: "approve", note: "" }),
    promotions.command(staff, { id: p1.id, revision: 1, commandId: randomUUID(), action: "reject", note: "No" }),
  ])
  assert.equal(decisions.filter((d) => d.status === "fulfilled").length, 1)
  const decided = await promotions.get(staff, p1.id)
  assert.equal(decided.transitions.filter((t) => t.to === "submitted").length, 1)
  assert.equal(decided.transitions.filter((t) => t.to === "approved" || t.to === "rejected").length, 1)
  let appendOnly = false
  try {
    await db.update(associationPromotionTransition).set({ note: "edited" })
  } catch {
    appendOnly = true
  }
  assert(appendOnly, "transitions must reject UPDATE")
  assert.equal(
    (await promotions.queue(staff, { from: day, to: day })).length,
    1,
    "the queue filters by the desired day in SQL"
  )
  const [promotionMail] = (await db.select().from(associationMail)).filter(
    (m) => m.mail.template?.kind === "association-promotion"
  )
  assert.equal(promotionMail?.mail.to, "new@example.org")
  // Events: approval publishes them in SQL, past ones drop out, transitions are append-only.
  const eventStore = createEventStore(db)
  const events = createEventService(eventStore, store, "https://admin.example.org")
  const starts = new Date(Date.now() + 3 * 86_400_000).toISOString()
  const created = await events.create(userWithMail, {
    associationId: a.id,
    content: {
      title: "Serata",
      descriptionIt: "IT",
      descriptionEn: "EN",
      startsAt: starts,
      endsAt: null,
      online: true,
      venue: "",
      campus: null,
      link: "",
      poster: null,
    },
    commandId: randomUUID(),
  })
  await events.command(userWithMail, { id: created.id, revision: 0, commandId: randomUUID(), action: "submit" })
  assert.equal((await publicEvents(store, eventStore)).length, 0)
  await events.command(staff, { id: created.id, revision: 1, commandId: randomUUID(), action: "approve", note: "" })
  const calendar = await publicEvents(store, eventStore)
  assert.deepEqual(
    calendar.map((e) => [e.title, e.associationName, e.startsAt]),
    [["Serata", "New", starts]]
  )
  await db
    .update(associationEvent)
    .set({ startsAt: new Date(Date.now() - 3 * 86_400_000) })
    .where(eq(associationEvent.id, created.id))
  assert.equal((await publicEvents(store, eventStore)).length, 0, "past events leave the calendar")
  let eventAppendOnly = false
  try {
    await db.delete(associationEventTransition)
  } catch {
    eventAppendOnly = true
  }
  assert(eventAppendOnly, "event transitions must reject DELETE")
  for (const row of await db.select().from(associationRegistry))
    assert.deepEqual(row.state.collaboration ?? { open: false, contactId: null }, { open: false, contactId: null })
  const [backfilled] = await client.unsafe(
    `SELECT count(*)::int AS n FROM web_association_registry WHERE NOT state ? 'collaboration'`
  )
  assert.equal(backfilled.n, 0)
  const visible = async (viewer: { sub: string; name: string; operator: boolean }) =>
    ((await service.directory(viewer)).find((r) => r.id === a.id)?.contacts ?? []).map((c) => c.label).sort()
  assert.deepEqual(await visible({ sub: "nobody", name: "Nobody", operator: false }), ["public"])
  assert.deepEqual(await visible(staff), ["associations", "polinetwork", "public"])
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
        "jsonb objects and invitation lookup",
        "catalogue seed",
        "registry backfill",
        "contact visibility",
        "promotion idempotency and concurrent decisions",
        "event publication and append-only transitions",
      ],
    })
  )
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${name}`)
  await admin.close()
  await rm(folder, { recursive: true, force: true })
}
