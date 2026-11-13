import assert from "node:assert/strict"
import { SQL } from "bun"
import type { Context } from "@/trpc"

// A disposable database on the integration server, with the fixed test credentials used in CI.
const config = { hostname: "127.0.0.1", port: Number(process.env.SEED_TEST_DB_PORT), username: "seed_test" }
const password = "seed_test"
const database = `documents_test_${process.pid}`
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
  const { DB } = await import("@/db") // Applies every migration, the documents tables included.
  closeBackend = () => DB.$client.close()

  // Keep uploads in memory instead of Azure.
  const blob = await import("@/azure/blob")
  const stored = new Set<string>()
  const removed: string[] = []
  Object.assign(blob.containerClient, {
    getBlockBlobClient: (name: string) => ({
      upload: async () => {
        stored.add(name)
        return { requestId: "test" }
      },
      deleteIfExists: async () => {
        removed.push(name)
        return { succeeded: stored.delete(name) }
      },
    }),
  })

  const documents = (await import("@/routers/web/documents")).default
  const context = (permissions: string[]): Context => ({
    auth: {
      kind: "token",
      actor: { kind: "user", sub: "documents-editor", client: "admin", telegramId: null },
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
  const editor = documents.createCaller(context(["admin:access", "web:content:write"]))
  const viewer = documents.createCaller(context(["admin:access"]))
  const website = documents.createCaller({
    auth: { kind: "token", actor: { kind: "service", client: "website" }, scopes: new Set(["backend:public:read"]) },
  })
  const pdf = (name = "file.pdf", type = "application/pdf") => new File(["%PDF-1.4 test"], name, { type })
  const form = (fields: Record<string, string | File>) => {
    const fd = new FormData()
    for (const [key, value] of Object.entries(fields)) fd.append(key, value)
    return fd
  }
  const ok = <T>(result: T): Exclude<T, { error: unknown }> => {
    assert.ok(result && typeof result === "object" && !("error" in result), JSON.stringify(result))
    return result as Exclude<T, { error: unknown }>
  }

  assert.deepEqual(await website.getCatalog(), [])
  assert.deepEqual(await editor.getAdminCatalog(), [])
  await assert.rejects(website.getAdminCatalog(), { code: "FORBIDDEN" })
  await assert.rejects(website.createCategory({ slug: "x", title: "X", description: "" }), { code: "FORBIDDEN" })
  await assert.rejects(viewer.createCategory({ slug: "x", title: "X", description: "" }), { code: "FORBIDDEN" })
  assert.deepEqual(await viewer.getAdminCatalog(), [])
  checked.push(
    "the website reads only the public catalog; the dashboard reads with admin:access, writes need web:content:write"
  )

  const statuto = ok(await editor.createCategory({ slug: "statuto", title: "Statuto", description: "Atti" }))
  const bilanci = ok(await editor.createCategory({ slug: "bilanci", title: "Bilanci", description: "" }))
  const vuota = ok(await editor.createCategory({ slug: "vuota", title: "Vuota", description: "" }))
  assert.deepEqual(statuto, { id: statuto.id, slug: "statuto", title: "Statuto", description: "Atti", position: 0 })
  assert.deepEqual([bilanci.position, vuota.position], [1, 2])
  assert.deepEqual(await editor.createCategory({ slug: "statuto", title: "Again", description: "" }), {
    error: "DUPLICATE_SLUG",
  })
  for (const slug of ["Statuto", "a b", "-a", "a--b", "a-", ""])
    await assert.rejects(editor.createCategory({ slug, title: "X", description: "" }), { code: "BAD_REQUEST" })
  assert.deepEqual(await editor.updateCategory({ id: 999_999, title: "X" }), { error: "NOT_FOUND" })
  assert.deepEqual(await editor.updateCategory({ id: bilanci.id, slug: "statuto" }), { error: "DUPLICATE_SLUG" })
  assert.deepEqual(await editor.updateCategory({ id: bilanci.id, slug: "bilanci", title: "Bilanci annuali" }), {
    ...bilanci,
    title: "Bilanci annuali",
  })
  assert.deepEqual(
    (await connection`SELECT created_by_sub, modified_by_sub FROM web_document_categories WHERE id = ${bilanci.id}`)[0],
    { created_by_sub: "documents-editor", modified_by_sub: "documents-editor" }
  )
  checked.push("categories: create goes last, update, duplicate slugs, kebab-case slugs and authorship")

  const atto = ok(await editor.createDocument({ categoryId: statuto.id, slug: "atto-costitutivo", title: "Atto" }))
  const statutoDoc = ok(
    await editor.createDocument({ categoryId: statuto.id, slug: "statuto", title: "Statuto", description: "Vigente" })
  )
  const bilancio = ok(await editor.createDocument({ categoryId: bilanci.id, slug: "bilancio-2025", title: "B 2025" }))
  assert.deepEqual(atto, {
    id: atto.id,
    categoryId: statuto.id,
    slug: "atto-costitutivo",
    title: "Atto",
    description: null,
    position: 0,
  })
  assert.deepEqual([statutoDoc.position, bilancio.position], [1, 0])
  assert.deepEqual(await editor.createDocument({ categoryId: 999_999, slug: "x", title: "X" }), {
    error: "CATEGORY_NOT_FOUND",
  })
  assert.deepEqual(await editor.createDocument({ categoryId: bilanci.id, slug: "statuto", title: "X" }), {
    error: "DUPLICATE_SLUG",
  })
  assert.deepEqual(await website.getCatalog(), [])
  assert.equal(await website.getDocument({ slug: "statuto" }), null)
  checked.push("documents: create goes last in its category, errors, and documents without versions stay hidden")

  const addVersion = (documentId: number, version: string, date: string, file: File = pdf()) =>
    editor.addVersion(form({ documentId: String(documentId), version, date, file }))
  const v1 = ok(await addVersion(statutoDoc.id, "1.0", "2024-01-01"))
  const v2 = ok(await addVersion(statutoDoc.id, "2.0", "2025-06-01"))
  const v3 = ok(await addVersion(statutoDoc.id, "1.1", "2025-06-01")) // Same date, greater id: the latest.
  assert.deepEqual(Object.keys(v1).sort(), ["date", "file", "id", "version"])
  assert.deepEqual(await addVersion(statutoDoc.id, "2.0", "2026-01-01"), { error: "DUPLICATE_VERSION" })
  assert.deepEqual(await addVersion(999_999, "1.0", "2026-01-01"), { error: "NOT_FOUND" })
  await assert.rejects(addVersion(statutoDoc.id, "3.0", "2026-01-01", pdf("x.png", "image/png")), {
    code: "BAD_REQUEST",
  })
  await assert.rejects(addVersion(statutoDoc.id, "3.0", "01/02/2026"), { code: "BAD_REQUEST" })
  assert.equal(stored.size, 3)
  ok(await addVersion(atto.id, "2.0", "2020-01-01")) // The same label on another document is allowed.
  checked.push("versions: PDF only, ISO dates, unique per document, NOT_FOUND for missing documents")

  const catalog = await website.getCatalog()
  assert.deepEqual(
    catalog.map((c) => [c.slug, c.documents.map((d) => [d.slug, d.latest.version])]),
    [
      [
        "statuto",
        [
          ["atto-costitutivo", "2.0"],
          ["statuto", "1.1"],
        ],
      ],
    ]
  )
  assert.deepEqual(catalog[0].documents[1], {
    id: statutoDoc.id,
    slug: "statuto",
    title: "Statuto",
    description: "Vigente",
    position: 1,
    latest: v3,
  })
  assert.equal("createdBySub" in catalog[0], false)
  const detail = await website.getDocument({ slug: "statuto" })
  assert.deepEqual(detail, {
    id: statutoDoc.id,
    slug: "statuto",
    title: "Statuto",
    description: "Vigente",
    category: { id: statuto.id, slug: "statuto", title: "Statuto" },
    latest: v3,
    versions: [v3, v2, v1],
  })
  assert.equal(await website.getDocument({ slug: "missing" }), null)
  const adminCatalog = await editor.getAdminCatalog()
  assert.deepEqual(
    adminCatalog.map((c) => [c.slug, c.documents.map((d) => [d.slug, d.versions.map((v) => v.version)])]),
    [
      [
        "statuto",
        [
          ["atto-costitutivo", ["2.0"]],
          ["statuto", ["1.1", "2.0", "1.0"]],
        ],
      ],
      ["bilanci", [["bilancio-2025", []]]],
      ["vuota", []],
    ]
  )
  checked.push("the public catalog shows the latest version and hides empty categories; the admin catalog shows all")

  await editor.reorderCategories({ ids: [vuota.id, bilanci.id, statuto.id] })
  await editor.reorderDocuments({ categoryId: statuto.id, ids: [statutoDoc.id, atto.id, bilancio.id] })
  await assert.rejects(editor.reorderCategories({ ids: [vuota.id, vuota.id] }), { code: "BAD_REQUEST" })
  ok(await addVersion(bilancio.id, "2025", "2026-04-30"))
  assert.deepEqual(
    (await website.getCatalog()).map((c) => [c.slug, c.documents.map((d) => d.slug)]),
    [
      ["bilanci", ["bilancio-2025"]],
      ["statuto", ["statuto", "atto-costitutivo"]],
    ]
  )
  // A document of another category is not moved by reordering this one.
  assert.equal((await connection`SELECT position FROM web_documents WHERE id = ${bilancio.id}`)[0].position, 0)
  checked.push("categories and documents follow their saved order")

  assert.deepEqual(await editor.updateDocument({ id: 999_999, title: "X" }), { error: "NOT_FOUND" })
  assert.deepEqual(await editor.updateDocument({ id: atto.id, categoryId: 999_999 }), {
    error: "CATEGORY_NOT_FOUND",
  })
  assert.deepEqual(await editor.updateDocument({ id: atto.id, slug: "statuto" }), { error: "DUPLICATE_SLUG" })
  assert.deepEqual(await editor.updateDocument({ id: atto.id, categoryId: bilanci.id, description: "Nuovo" }), {
    ...atto,
    categoryId: bilanci.id,
    description: "Nuovo",
    position: 1,
  })
  assert.equal(ok(await editor.updateDocument({ id: atto.id, description: null })).description, null)
  checked.push("documents: update, move to the end of another category, and errors")

  assert.deepEqual(await editor.deleteCategory({ id: bilanci.id }), { error: "CATEGORY_NOT_EMPTY" })
  assert.deepEqual(await editor.deleteCategory({ id: vuota.id }), { error: null })
  assert.deepEqual(await editor.deleteCategory({ id: vuota.id }), { error: "NOT_FOUND" })
  checked.push("only empty categories can be deleted")

  const before = removed.length
  assert.deepEqual(await editor.deleteVersion({ id: v3.id }), { error: null })
  assert.deepEqual(removed.slice(before), [new URL(v3.file).pathname.split("/").pop()])
  assert.deepEqual(await editor.deleteVersion({ id: v3.id }), { error: "NOT_FOUND" })
  assert.deepEqual((await website.getDocument({ slug: "statuto" }))?.latest, v2)
  assert.deepEqual(await editor.deleteDocument({ id: statutoDoc.id }), { error: null })
  assert.deepEqual(await editor.deleteDocument({ id: statutoDoc.id }), { error: "NOT_FOUND" })
  assert.deepEqual(
    removed.slice(before + 1).sort(),
    [v1.file, v2.file].map((file) => new URL(file).pathname.split("/").pop()).sort()
  )
  assert.equal(
    (await connection`SELECT count(*)::int AS count FROM web_document_versions WHERE document_id = ${statutoDoc.id}`)[0]
      .count,
    0
  )
  assert.equal(await website.getDocument({ slug: "statuto" }), null)
  checked.push("deleting a version or a document deletes its files")

  console.log(JSON.stringify({ checked }))
} finally {
  await closeBackend?.()
  await connection.close()
  await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`)
  await admin.close()
}
