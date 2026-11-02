import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { HocuspocusProvider } from "@hocuspocus/provider"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import pino from "pino"
import * as Y from "yjs"
import { schema } from "@/db/schema"
import { documents, drafts, snapshots, versions, ydocs, yupdates } from "@/db/schema/regulations"
import { createCollabControl } from "@/regulations/collab/internal-client"
import { startCollab } from "@/regulations/collab/server"
import { issueTicket } from "@/regulations/collab/tickets"
import { encodeFiles, filesMap } from "@/regulations/collab/ydoc"
import type { CompileEvent } from "@/regulations/compile/service"
import type { DraftRole } from "@/regulations/contract"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const databaseName = `regs_collab_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName })
const db = drizzle({ client, schema })
const checked: string[] = []
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(what: string, condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now()
  while (!(await condition())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`)
    await wait(25)
  }
}

const fixture = (() => {
  const dir = join(import.meta.dirname, "fixtures/regulations/sample")
  const out: Record<string, string> = {}
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) visit(full)
      else out[relative(dir, full)] = readFileSync(full, "utf8")
    }
  }
  visit(dir)
  return out
})()

type Collab = Awaited<ReturnType<typeof startCollab>>
let collab: Collab | null = null
const providers: HocuspocusProvider[] = []
try {
  await migrate(db, { migrationsFolder: "./drizzle" })
  const now = new Date()
  await db.insert(documents).values({
    key: "sample",
    title: "Raccolta di prova",
    dir: "sample",
    entry: "main.tex",
    sources: ["main.tex", "parti/*.tex"],
    outputs: { pdf: "sample.pdf" },
    tagPrefix: "sample-",
    procedure: "rri",
  })
  await db.insert(versions).values({
    id: "v1",
    documentKey: "sample",
    tag: null,
    label: "import",
    files: fixture,
    sourceHash: "x",
    publishedAt: now,
    assetsBlob: "a".repeat(64),
  })
  const person = { id: "anna", name: "Anna", email: null }
  await db.insert(drafts).values({
    id: "draft-0001",
    documentKey: "sample",
    title: "Bozza",
    kind: "modifica",
    state: "bozza",
    baseVersionId: "v1",
    baseFiles: fixture,
    createdBy: person,
    createdAt: now,
    updatedAt: now,
    stateChangedAt: now,
  })
  await db.insert(ydocs).values({ draftId: "draft-0001", state: encodeFiles(fixture), updatedAt: now })

  const compiles: { draftId: string; files: Record<string, string> }[] = []
  let emit: (e: CompileEvent) => void = () => {}
  const start = async () => {
    const instance = await startCollab({
      db,
      logger: pino({ level: "warn" }),
      port: 0,
      internalPort: 0,
      internalSecret: "x".repeat(32),
      idleMs: 150,
      compiler: {
        async request(job) {
          compiles.push(job)
          const hash = String(compiles.length).padStart(64, "0")
          setTimeout(() => emit({ draftId: job.draftId, hash, state: "ok" }), 10)
          return hash
        },
      },
    })
    emit = instance.onCompileEvent
    return instance
  }
  collab = await start()
  const url = () => `ws://127.0.0.1:${(collab as Collab).port}`
  const control = () =>
    createCollabControl({ url: `http://127.0.0.1:${(collab as Collab).internal.port}`, secret: "x".repeat(32) })

  const connect = async (role: DraftRole, options: { reuse?: string } = {}) => {
    const fresh = async () =>
      (
        await issueTicket(db, {
          draftId: "draft-0001",
          user: { id: role, name: role, email: null },
          role,
          readOnly: role !== "editor",
        })
      ).ticket
    // Like the dashboard: a new ticket for every (re)connection. `reuse` replays one ticket instead.
    const ticket = options.reuse ?? (await fresh())
    let first = true
    const token = options.reuse
      ? ticket
      : async () => {
          if (first) {
            first = false
            return ticket
          }
          return fresh()
        }
    const doc = new Y.Doc()
    const stateless: string[] = []
    let failed = false
    const provider = new HocuspocusProvider({
      url: url(),
      name: "draft-0001",
      document: doc,
      token,
      onStateless: ({ payload }) => {
        stateless.push(payload)
      },
      onAuthenticationFailed: () => {
        failed = true
      },
    })
    providers.push(provider)
    return { doc, provider, ticket, stateless, failed: () => failed, synced: () => provider.isSynced }
  }
  const text = (doc: Y.Doc, path = "parti/secondo.tex") => filesMap(doc).get(path)?.toString() ?? ""

  const a = await connect("editor")
  const b = await connect("editor")
  await until("both clients synced", () => a.synced() && b.synced())
  assert.equal(text(a.doc), fixture["parti/secondo.tex"])
  checked.push("two clients load the draft from Postgres")

  filesMap(a.doc).get("parti/secondo.tex")?.insert(0, "% nota di A\n")
  await until("B sees A's edit", () => text(b.doc).startsWith("% nota di A\n"))
  const sanzioni = text(b.doc).indexOf("Le sanzioni")
  filesMap(b.doc).get("parti/secondo.tex")?.insert(sanzioni, "In ogni caso, ")
  await until("A sees B's edit", () => text(a.doc).includes("In ogni caso, Le sanzioni"))
  checked.push("edits sync between two clients in both directions")

  const c = await connect("commenter")
  await until("commenter synced", () => c.synced())
  filesMap(c.doc).get("parti/secondo.tex")?.insert(0, "% del commentatore\n")
  await wait(400)
  assert.equal(text(a.doc).includes("del commentatore"), false)
  checked.push("a commenter's connection is read-only")

  const reused = await connect("editor", { reuse: a.ticket })
  await until("reused ticket refused", () => reused.failed())
  checked.push("a ticket works once")

  // The system inserts ids: someone types an article without one.
  const end = text(a.doc).length
  filesMap(a.doc).get("parti/secondo.tex")?.insert(end, "\n\\articolo{Nuovo articolo}\nTesto nuovo.\n")
  await until("an id is inserted", () => /\\articolo\[id=[0-9a-z]{6}\]\{Nuovo articolo\}/.test(text(b.doc)))
  checked.push("the server inserts a missing id, and both clients see it")

  await until("compile requested", () =>
    compiles.some((job) => job.files["parti/secondo.tex"]?.includes("Nuovo articolo"))
  )
  await until("compile broadcast", () => a.stateless.some((s) => JSON.parse(s).type === "compile"))
  const [row] = await db.select({ parses: drafts.parses }).from(drafts).where(eq(drafts.id, "draft-0001"))
  assert.equal(row.parses, true)
  checked.push("after a pause it compiles the latest text and broadcasts the compile state")

  const frozen = await control().freeze("draft-0001")
  assert.equal(frozen.parses, true)
  assert.ok(frozen.files["parti/secondo.tex"].includes("Nuovo articolo"))
  await until("state broadcast", () => b.stateless.some((s) => JSON.parse(s).type === "state"))
  filesMap(a.doc).get("parti/secondo.tex")?.insert(0, "% dopo il blocco\n")
  await wait(400)
  assert.equal((await control().text("draft-0001"))["parti/secondo.tex"].includes("dopo il blocco"), false)
  checked.push("freezing makes every connection read-only and returns the text")

  // The backend unfreezes in the database, then reopens: connections become writable in place.
  await db.update(drafts).set({ frozenFiles: null }).where(eq(drafts.id, "draft-0001"))
  await control().reopen("draft-0001")
  // A typed while frozen: its local document diverged, so (like the dashboard on a "state" message) it starts over.
  a.provider.destroy()
  const a2 = await connect("editor")
  await until("A reconnected", () => a2.synced())
  filesMap(a2.doc).get("parti/secondo.tex")?.insert(0, "% riaperto\n")
  await until("edits flow again after reopening", () => text(b.doc).startsWith("% riaperto\n"))
  await control().replace("draft-0001", { ...fixture, "parti/nuovo.tex": "% file nuovo\n" })
  await until(
    "replace reaches clients",
    () => filesMap(b.doc).has("parti/nuovo.tex") && filesMap(a2.doc).has("parti/nuovo.tex")
  )
  assert.equal(text(b.doc), fixture["parti/secondo.tex"])
  checked.push("the backend can replace the text (restore, merge) and clients follow")

  // Persistence: stop everything, start again, the text is still there.
  for (const p of providers) p.destroy()
  providers.length = 0
  await wait(300)
  await (collab as Collab).stop()
  const logged = await db.select().from(yupdates).where(eq(yupdates.draftId, "draft-0001"))
  const [stored] = await db.select().from(ydocs).where(eq(ydocs.draftId, "draft-0001"))
  assert.ok(stored.compactedThrough > 0, "the update log was compacted")
  assert.ok(logged.every((u) => u.id > stored.compactedThrough))
  collab = await start()
  const d = await connect("viewer")
  await until("viewer synced after restart", () => d.synced())
  assert.ok(filesMap(d.doc).has("parti/nuovo.tex"))
  assert.equal(text(d.doc), fixture["parti/secondo.tex"])
  checked.push("the text survives a restart, from the compacted state and the update log")

  const snaps = await db.select().from(snapshots).where(eq(snapshots.draftId, "draft-0001"))
  assert.ok(snaps.some((s) => s.kind === "auto"))
  checked.push("an automatic snapshot is taken when the document is stored")
  console.log(JSON.stringify({ checked }))
} finally {
  for (const p of providers) p.destroy()
  await collab?.stop().catch(() => {})
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
