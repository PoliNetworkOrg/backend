import assert from "node:assert/strict"
import { SQL } from "bun"
import type { Context } from "@/trpc"

// A disposable database on the integration server, with the fixed test credentials used in CI.
const config = { hostname: "127.0.0.1", port: Number(process.env.SEED_TEST_DB_PORT), username: "seed_test" }
const password = "seed_test"
const database = `acknowledgements_test_${process.pid}`
const admin = new SQL({ ...config, password, database: "postgres" })
await admin.unsafe(`CREATE DATABASE ${database}`)
const connection = new SQL({ ...config, password, database })
const checked: string[] = []
let closeBackend: (() => Promise<void>) | undefined
try {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_HOST: config.hostname,
    DB_PORT: String(config.port),
    DB_USER: config.username,
    DB_PASS: password,
    DB_NAME: database,
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  })
  const { DB } = await import("@/db") // Applies every migration, the acknowledgements tables included.
  closeBackend = () => DB.$client.close()

  const acknowledgements = (await import("@/routers/web/acknowledgements")).default
  const context = (permissions: string[]): Context => ({
    auth: {
      kind: "token",
      actor: { kind: "user", sub: "acknowledgements-editor", client: "admin", telegramId: null },
      scopes: new Set(["backend:admin"]),
    },
    access: {
      has: (_, permission) => permissions.includes(permission),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ lastSyncAt: 1, fresh: true, generation: 1, subjects: 1 }),
    },
  })
  const editor = acknowledgements.createCaller(context(["admin:access", "web:content:write"]))
  const viewer = acknowledgements.createCaller(context(["admin:access"]))
  const website = acknowledgements.createCaller({
    auth: { kind: "token", actor: { kind: "service", client: "website" }, scopes: new Set(["backend:public:read"]) },
  })
  const ok = <T>(result: T): Exclude<T, { error: unknown }> => {
    assert.ok(result && typeof result === "object" && !("error" in result), JSON.stringify(result))
    return result as Exclude<T, { error: unknown }>
  }
  const names = async () => {
    const all = await website.getAll()
    return {
      website: all.website.map((group) => [group.title, group.entries.map((entry) => entry.name)]),
      projects: all.projects.map((entry) => entry.name),
    }
  }

  assert.deepEqual(await website.getAll(), { website: [], projects: [] })
  assert.deepEqual(await viewer.getAll(), { website: [], projects: [] })
  await assert.rejects(website.createGroup({ title: "X", icon: "code" }), { code: "FORBIDDEN" })
  await assert.rejects(viewer.createGroup({ title: "X", icon: "code" }), { code: "FORBIDDEN" })
  await assert.rejects(viewer.createEntry({ list: { section: "projects" }, name: "X" }), { code: "FORBIDDEN" })
  checked.push("everyone reads the page; writes need web:content:write")

  const pm = ok(await editor.createGroup({ title: "Project manager", icon: "settings" }))
  const design = ok(await editor.createGroup({ title: "Designer", icon: "palette" }))
  const dev = ok(await editor.createGroup({ title: "Developer", icon: "code" }))
  assert.deepEqual(pm, { id: pm.id, title: "Project manager", icon: "settings", position: 0 })
  assert.deepEqual([design.position, dev.position], [1, 2])
  await assert.rejects(editor.createGroup({ title: "  ", icon: "code" }), { code: "BAD_REQUEST" })
  // @ts-expect-error: only the listed icons are accepted.
  await assert.rejects(editor.createGroup({ title: "X", icon: "rocket" }), { code: "BAD_REQUEST" })
  assert.deepEqual(await editor.updateGroup({ id: 999_999, title: "X" }), { error: "NOT_FOUND" })
  assert.deepEqual(await editor.updateGroup({ id: design.id, title: "Designer UX", icon: "smile" }), {
    ...design,
    title: "Designer UX",
    icon: "smile",
  })
  assert.deepEqual(
    (
      await connection`SELECT created_by_sub, modified_by_sub FROM web_acknowledgement_groups WHERE id = ${design.id}`
    )[0],
    { created_by_sub: "acknowledgements-editor", modified_by_sub: "acknowledgements-editor" }
  )
  checked.push("groups: create goes last, update, validation and authorship")

  const anna = ok(
    await editor.createEntry({ list: { section: "website", groupId: dev.id }, name: " Anna ", detail: "Backend" })
  )
  const bruno = ok(
    await editor.createEntry({ list: { section: "website", groupId: dev.id }, name: "Bruno", detail: "" })
  )
  const carla = ok(await editor.createEntry({ list: { section: "website", groupId: pm.id }, name: "Carla" }))
  const dario = ok(await editor.createEntry({ list: { section: "projects" }, name: "Dario", detail: "PoliAule" }))
  const elena = ok(await editor.createEntry({ list: { section: "projects" }, name: "Elena", detail: "Orario" }))
  assert.deepEqual(anna, {
    id: anna.id,
    section: "website",
    groupId: dev.id,
    name: "Anna",
    detail: "Backend",
    position: 0,
  })
  assert.deepEqual([bruno.detail, bruno.position, carla.position, dario.groupId, elena.position], [null, 1, 0, null, 1])
  assert.deepEqual(await editor.createEntry({ list: { section: "website", groupId: 999_999 }, name: "X" }), {
    error: "GROUP_NOT_FOUND",
  })
  await assert.rejects(editor.createEntry({ list: { section: "projects" }, name: "" }), { code: "BAD_REQUEST" })
  await assert.rejects(editor.createEntry({ list: { section: "projects" }, name: "X", detail: "x".repeat(81) }), {
    code: "BAD_REQUEST",
  })
  // @ts-expect-error: a website person needs a group.
  await assert.rejects(editor.createEntry({ list: { section: "website" }, name: "X" }), { code: "BAD_REQUEST" })
  await assert.rejects(
    connection`INSERT INTO web_acknowledgements (section, name, created_by_sub) VALUES ('website', 'X', 'test')`
  )
  await assert.rejects(
    connection`INSERT INTO web_acknowledgements (section, group_id, name, created_by_sub) VALUES ('projects', ${pm.id}, 'X', 'test')`
  )
  assert.deepEqual(await website.getAll(), {
    website: [
      {
        id: pm.id,
        title: "Project manager",
        icon: "settings",
        entries: [{ id: carla.id, name: "Carla", detail: null }],
      },
      { id: design.id, title: "Designer UX", icon: "smile", entries: [] },
      {
        id: dev.id,
        title: "Developer",
        icon: "code",
        entries: [
          { id: anna.id, name: "Anna", detail: "Backend" },
          { id: bruno.id, name: "Bruno", detail: null },
        ],
      },
    ],
    projects: [
      { id: dario.id, name: "Dario", detail: "PoliAule" },
      { id: elena.id, name: "Elena", detail: "Orario" },
    ],
  })
  checked.push("people: added last in their list, trimmed, empty details stored as none, sections kept apart")

  assert.deepEqual(await editor.updateEntry({ id: 999_999, name: "X" }), { error: "NOT_FOUND" })
  assert.deepEqual(await editor.updateEntry({ id: bruno.id, detail: "Frontend" }), {
    ...bruno,
    detail: "Frontend",
  })
  assert.deepEqual(await editor.updateEntry({ id: anna.id, name: "Anna Bianchi", detail: null }), {
    ...anna,
    name: "Anna Bianchi",
    detail: null,
  })
  checked.push("people: update name and detail, and clear the detail")

  const before = await editor.getAll()
  for (const ids of [[pm.id], [pm.id, design.id, 999_999]])
    assert.deepEqual(await editor.reorderGroups({ ids }), { error: "INVALID_ORDER" })
  for (const ids of [[anna.id], [anna.id, carla.id], [anna.id, bruno.id, 999_999]])
    assert.deepEqual(await editor.reorderEntries({ list: { section: "website", groupId: dev.id }, ids }), {
      error: "INVALID_ORDER",
    })
  assert.deepEqual(await editor.reorderEntries({ list: { section: "projects" }, ids: [dario.id, anna.id] }), {
    error: "INVALID_ORDER",
  })
  assert.deepEqual(await editor.reorderEntries({ list: { section: "website", groupId: 999_999 }, ids: [anna.id] }), {
    error: "INVALID_ORDER",
  })
  await assert.rejects(editor.reorderGroups({ ids: [pm.id, pm.id] }), { code: "BAD_REQUEST" })
  assert.deepEqual(await editor.getAll(), before)
  assert.deepEqual(await editor.reorderGroups({ ids: [dev.id, pm.id, design.id] }), { error: null })
  assert.deepEqual(
    await editor.reorderEntries({ list: { section: "website", groupId: dev.id }, ids: [bruno.id, anna.id] }),
    { error: null }
  )
  assert.deepEqual(await editor.reorderEntries({ list: { section: "projects" }, ids: [elena.id, dario.id] }), {
    error: null,
  })
  assert.deepEqual(await names(), {
    website: [
      ["Developer", ["Bruno", "Anna Bianchi"]],
      ["Project manager", ["Carla"]],
      ["Designer UX", []],
    ],
    projects: ["Elena", "Dario"],
  })
  checked.push("groups and people follow their saved order; partial or foreign orders are refused")

  assert.deepEqual(await editor.deleteEntry({ id: elena.id }), { error: null })
  assert.deepEqual(await editor.deleteEntry({ id: elena.id }), { error: "NOT_FOUND" })
  assert.deepEqual(await editor.deleteGroup({ id: dev.id }), { error: null })
  assert.deepEqual(await editor.deleteGroup({ id: dev.id }), { error: "NOT_FOUND" })
  assert.equal(
    (await connection`SELECT count(*)::int AS count FROM web_acknowledgements WHERE id IN (${anna.id}, ${bruno.id})`)[0]
      .count,
    0
  )
  assert.deepEqual(await names(), {
    website: [
      ["Project manager", ["Carla"]],
      ["Designer UX", []],
    ],
    projects: ["Dario"],
  })
  // A new group still goes last, after the remaining ones.
  const other = ok(await editor.createGroup({ title: "Altri contributi", icon: "smile" }))
  assert.equal(other.position, 3)
  checked.push("deleting a person, and a group with its people")

  // The router is called on its own here, so actions are its procedure names without the `web.acknowledgements.` prefix.
  const events = async (action: string) =>
    (
      await connection`SELECT outcome, target_type, target_id, before #>> '{}' AS before, after #>> '{}' AS after
        FROM common_audit_events WHERE action = ${action} ORDER BY id`
    ).map(
      (event: {
        outcome: string
        target_type: string
        target_id: string
        before: string | null
        after: string | null
      }) => ({
        ...event,
        before: event.before === null ? null : JSON.parse(event.before),
        after: event.after === null ? null : JSON.parse(event.after),
      })
    )
  const [missingGroup, renamed] = await events("updateGroup")
  assert.deepEqual(
    [renamed.outcome, renamed.target_type, renamed.target_id, renamed.before.title, renamed.after.title],
    ["success", "web.acknowledgementGroup", String(design.id), "Designer", "Designer UX"]
  )
  assert.deepEqual([missingGroup.outcome, missingGroup.before, missingGroup.after], ["failure", null, null])
  const deletedGroup = (await events("deleteGroup")).find((event: { outcome: string }) => event.outcome === "success")
  assert.deepEqual(
    [
      deletedGroup?.target_id,
      deletedGroup?.before.title,
      deletedGroup?.before.entries.map((e: { name: string }) => e.name),
    ],
    [String(dev.id), "Developer", ["Bruno", "Anna Bianchi"]]
  )
  const [projectsOrder] = (await events("reorderEntries")).filter(
    (event: { outcome: string; target_id: string }) => event.outcome === "success" && event.target_id === "projects"
  )
  assert.deepEqual(
    [projectsOrder.target_type, projectsOrder.after.map((row: { name: string }) => row.name)],
    ["web.acknowledgements", ["Elena", "Dario"]]
  )
  checked.push("audit events name the target and keep the states before and after")

  const concurrent = (
    await Promise.all(
      ["a", "b", "c"].map((name) => editor.createEntry({ list: { section: "website", groupId: pm.id }, name }))
    )
  ).map(ok)
  assert.equal(new Set(concurrent.map((entry) => entry.position)).size, 3)
  const groupIds = (await editor.getAll()).website.map((group) => group.id)
  const pmIds = (await editor.getAll()).website[0].entries.map((entry) => entry.id)
  for (const result of await Promise.all([
    editor.reorderGroups({ ids: [...groupIds].reverse() }),
    editor.reorderGroups({ ids: groupIds }),
    editor.reorderEntries({ list: { section: "website", groupId: pm.id }, ids: [...pmIds].reverse() }),
    editor.reorderEntries({ list: { section: "website", groupId: pm.id }, ids: pmIds }),
    editor.createEntry({ list: { section: "projects" }, name: "Fabio" }),
  ]))
    assert.ok(!("error" in result) || result.error === null, JSON.stringify(result))
  checked.push("concurrent additions get distinct positions and reorders finish without deadlock")

  console.log(JSON.stringify({ checked }))
} finally {
  await closeBackend?.()
  await connection.close()
  await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`)
  await admin.close()
}
