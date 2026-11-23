import assert from "node:assert/strict"
import { SQL } from "bun"

const port = process.env.SEED_TEST_DB_PORT
if (!port) throw new Error("Set SEED_TEST_DB_PORT to a disposable PostgreSQL server")
const database = `project_resources_test_${process.pid}`
const admin = new SQL({
  hostname: "127.0.0.1",
  port: Number(port),
  username: "seed_test",
  password: "seed_test",
  database: "postgres",
})
await admin.unsafe(`CREATE DATABASE ${database}`)
let closeBackend: (() => Promise<void>) | undefined
try {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DB_HOST: "127.0.0.1",
    DB_PORT: port,
    DB_USER: "seed_test",
    DB_PASS: "seed_test",
    DB_NAME: database,
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  })
  const { DB, SCHEMA } = await import("@/db")
  closeBackend = () => DB.$client.close()
  const { default: projects } = await import("@/routers/web/projects")
  const editor = projects.createCaller({
    auth: {
      kind: "token",
      actor: { kind: "user", client: "admin-dashboard", sub: "usr_editor", telegramId: null },
      scopes: new Set(["backend:admin"]),
    },
    access: {
      has: () => true,
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ lastSyncAt: 1, fresh: true, generation: 1, subjects: 1 }),
    },
  })
  const website = projects.createCaller({
    auth: { kind: "token", actor: { kind: "service", client: "website" }, scopes: new Set(["backend:public:read"]) },
  })
  const [project, other] = await DB.insert(SCHEMA.WEB.projects)
    .values(
      ["App", "Other app"].map((title) => ({
        title,
        descriptionIt: title,
        descriptionEn: title,
        createdBySub: "usr_editor",
      }))
    )
    .returning()

  async function add(projectId: number) {
    const row = await editor.addProjectResource({ projectId, kind: "web", url: "https://example.com" })
    assert.ok(row && "id" in row)
    return row
  }
  const ids = async (id: number) => (await website.getProject({ id }))?.resources.map((row) => row.id)

  const first = await add(project.id)
  const second = await add(project.id)
  const third = await add(project.id)
  const fourth = await add(project.id)
  assert.equal(first.order, 0)
  assert.deepEqual(await editor.deleteProjectResource({ id: second.id }), { error: null })
  assert.deepEqual(await editor.deleteProjectResource({ id: third.id }), { error: null })
  const added = await add(project.id)
  assert.equal(added.order, 4)
  assert.deepEqual(await ids(project.id), [first.id, fourth.id, added.id])

  const foreign = await add(other.id)
  for (const invalidId of [second.id, foreign.id]) {
    assert.deepEqual(
      await editor.reorderProjectResources({ projectId: project.id, resourceIds: [added.id, invalidId, first.id] }),
      { error: "NOT_FOUND" }
    )
    assert.deepEqual(await ids(project.id), [first.id, fourth.id, added.id])
  }
  assert.deepEqual(
    await editor.reorderProjectResources({ projectId: project.id, resourceIds: [added.id, fourth.id, first.id] }),
    { error: null }
  )
  assert.deepEqual(await ids(project.id), [added.id, fourth.id, first.id])
  assert.deepEqual(await ids(other.id), [foreign.id])
} finally {
  await closeBackend?.()
  await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`)
  await admin.close()
}
