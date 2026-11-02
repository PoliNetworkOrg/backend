import assert from "node:assert/strict"
import { cpSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { PDFDocument } from "pdf-lib"
import { schema } from "@/db/schema"
import { drafts, notifications, versions, ydocs } from "@/db/schema/regulations"
import type { CollabControl } from "@/regulations/collab/internal-client"
import { createYjsPersistence } from "@/regulations/collab/persistence"
import { decodeFiles, encodeFiles } from "@/regulations/collab/ydoc"
import type { Files } from "@/regulations/contract"
import { REGULATION_PERMISSIONS as P } from "@/regulations/contract"
import { createDiffService } from "@/regulations/diff/service"
import { fakeSummarizer } from "@/regulations/diff/summarizer"
import { createDirectory } from "@/regulations/directory"
import { fakeGitHub } from "@/regulations/emanation/github"
import { createEmanationService, type EmanationNotifier } from "@/regulations/emanation/service"
import { parseDocument } from "@/regulations/latex"
import { localLegalSource } from "@/regulations/legal-source"
import { createRegulationsService, type RegulationsHooks, type Viewer } from "@/regulations/service"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const databaseName = `regs_emanation_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName })
const db = drizzle({ client, schema })
const checked: string[] = []
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function rejects(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    if (message) assert.match(error.message ?? "", message)
    return true
  })
}

try {
  await migrate(db, { migrationsFolder: "./drizzle" })
  const legal = mkdtempSync(join(tmpdir(), "regs-legal-"))
  cpSync(join(import.meta.dirname, "fixtures/regulations/sample"), join(legal, "sample"), { recursive: true })
  cpSync(join(import.meta.dirname, "fixtures/regulations/sample"), join(legal, "shared"), { recursive: true })
  writeFileSync(
    join(legal, "legal.json"),
    JSON.stringify({
      version: 1,
      shared: "shared",
      documents: [
        {
          key: "sample",
          title: "Raccolta di prova",
          dir: "sample",
          entry: "main.tex",
          sources: ["main.tex", "parti/*.tex"],
          outputs: { pdf: "sample.pdf" },
          tagPrefix: "sample-",
          procedure: "rri",
        },
      ],
    })
  )
  const people = [
    { sub: "segretario", name: "Sara Segretario", email: "segretario@example.org" },
    { sub: "presidente", name: "Paolo Presidente", email: null },
    { sub: "direttivo", name: "Dario Direttivo", email: null },
    { sub: "delegato", name: "Davide Delegato", email: null },
  ]
  const directory = createDirectory(async () => people)
  const grants: Record<string, string[]> = {
    segretario: [P.read, P.write, P.manage, P.rectify],
    presidente: [P.read, P.write, P.manage],
    direttivo: [P.read, P.write],
  }
  const as = async (sub: string): Promise<Viewer> => ({
    sub,
    can: (p) => grants[sub]?.includes(p) ?? false,
    person: await directory.person(sub),
  })

  const persistence = createYjsPersistence(db)
  const text = async (draftId: string) => decodeFiles((await persistence.load(draftId)) as Uint8Array)
  const write = async (draftId: string, files: Files) => {
    await db.delete(ydocs).where(eq(ydocs.draftId, draftId))
    await db.insert(ydocs).values({ draftId, state: encodeFiles(files), updatedAt: new Date() })
  }
  const collab: CollabControl = {
    text,
    replace: async (id, files) => {
      await write(id, files)
      return files
    },
    freeze: async (id) => {
      const files = await text(id)
      return { files, parses: parseDocument(files, "main.tex").parses }
    },
    reopen: async () => {},
    broadcast: async () => {},
    refresh: async () => {},
  }
  let clock = new Date("2026-11-10T10:00:00Z")
  const now = () => clock
  const hooks: RegulationsHooks = {}
  const service = createRegulationsService({
    db,
    directory,
    collab,
    collabUrl: "ws://x",
    legal: localLegalSource(legal),
    now,
    hooks,
  })
  const diff = createDiffService({ db, regulations: service, summarizer: fakeSummarizer(), now })
  hooks.sentToApproval = async (id, by) => {
    await diff.generate(id, by)
  }
  const official = await (async () => {
    const pdf = await PDFDocument.create()
    pdf.addPage()
    return pdf.save()
  })()
  const repo = fakeGitHub({
    ciDelayMs: 100,
    releaseDelayMs: 100,
    buildRelease: async () => [{ name: "sample.pdf", content: official }],
  })
  const emails: { to: string; kind: string; replyTo?: string; attachments: number }[] = []
  const posts: { files: string[]; text: string }[] = []
  let botUp = false
  const notifier: EmanationNotifier = {
    email: async (input) => {
      emails.push({
        to: input.to,
        kind: "emanazione",
        replyTo: input.replyTo?.address,
        attachments: input.attachments.length,
      })
    },
    delegaEmail: async (input) => {
      emails.push({ to: input.to, kind: `delega:${input.props.change}`, attachments: 0 })
    },
    telegram: async (payload) => {
      if (!botUp) throw new Error("Il bot Telegram non è connesso")
      posts.push({ files: payload.files.map((f) => f.filename), text: payload.text })
      return { messageIds: [101, 102] }
    },
  }
  const emanation = createEmanationService({
    db,
    regulations: service,
    diff,
    github: repo.client,
    collab,
    directory,
    notifier,
    config: {
      baseBranch: "main",
      emailTo: "soci@example.org",
      replyTo: "direttivo@example.org",
      direttivoEmail: "direttivo@example.org",
      telegram: { chatId: -100123, topicId: 7 },
      webUrl: (id) => `https://admin.example.org/regolamenti/${id}`,
      pollSeconds: 0,
    },
    now,
  })
  hooks.delegaChanged = (id, change) => emanation.delegaChanged(id, change)
  const until = async (what: string, fn: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      await emanation.tick()
      if (await fn()) return
      await wait(30)
    }
    throw new Error(`timed out: ${what}`)
  }

  const seg = await as("segretario")
  const pres = await as("presidente")
  const dir = await as("direttivo")
  const delegato = await as("delegato")
  await service.syncDocuments(seg)
  const versionId = (await service.listVersions(seg, "sample"))[0].id

  // ---- A modifica, approved, emanated ----
  const a = await service.createDraft(dir, {
    documentKey: "sample",
    title: "Maggioranze",
    from: { kind: "version", id: versionId },
    kind: "modifica",
  })
  const base = await text(a.id)
  await write(a.id, { ...base, "parti/primo.tex": base["parti/primo.tex"].replace("i due terzi", "i tre quarti") })
  await service.transition(dir, { draftId: a.id, to: "in_approvazione" })
  await diff.settled(a.id)
  await service.transition(pres, {
    draftId: a.id,
    to: "approvata",
    delibera: { body: "consiglio_direttivo", date: "2026-11-09" },
  })
  await rejects(emanation.start(dir, a.id), "FORBIDDEN")
  const started = await emanation.start(pres, a.id)
  assert.equal(started.steps[0].key, "pr")
  await rejects(emanation.start(pres, a.id), "CONFLICT")
  await until(
    "the PR merged, tagged and released",
    async () => (await emanation.get(pres, a.id)).steps.find((s) => s.key === "email")?.state === "done"
  )
  // The bot is down: email sent, Telegram failed and waiting for a retry.
  const failed = await emanation.get(pres, a.id)
  assert.equal(failed.status, "failed")
  assert.equal(failed.steps.find((s) => s.key === "telegram")?.detail, "Il bot Telegram non è connesso")
  const mainFiles = repo.files("main")
  assert.ok(String(mainFiles.get("sample/parti/primo.tex")).includes("i tre quarti"))
  assert.ok(String(mainFiles.get("sample/main.tex")).includes("\\approvazione{direttivo}{2026-11-09}"))
  assert.deepEqual(failed.steps.map((s) => [s.key, s.state]).slice(0, 6), [
    ["pr", "done"],
    ["checks", "done"],
    ["merge", "done"],
    ["tag", "done"],
    ["release", "done"],
    ["email", "done"],
  ])
  assert.equal(failed.tag, "sample-v2026.11.09")
  assert.ok(repo.log.includes("auto-merge #1") && repo.log.includes("merged #1"))
  assert.ok(repo.releases[0].assets.some((x) => x.name === "differenze-sample-v2026.11.09.pdf"))
  const [published] = await db.select().from(versions).where(eq(versions.tag, "sample-v2026.11.09"))
  assert.ok(published.pdfBlob && published.releaseUrl)
  const draftAfter = await service.getDraft(pres, a.id)
  assert.equal(draftAfter.state, "emanata")
  assert.ok(draftAfter.notifiedAt)
  assert.deepEqual(
    draftAfter.deadlines.map((x) => x.key),
    ["opposizione"]
  )
  checked.push(
    "a PR with the generated sources auto-merges after CI, then the tag, the release with the differences PDF, the version"
  )

  assert.deepEqual(emails, [
    { to: "soci@example.org", kind: "emanazione", replyTo: "direttivo@example.org", attachments: 1 },
  ])
  botUp = true
  const resumed = await emanation.retry(pres, a.id)
  assert.equal(resumed.status, "done")
  assert.equal(posts.length, 1)
  assert.deepEqual(posts[0].files, ["sample.pdf", "differenze-sample-v2026.11.09.pdf"])
  assert.ok(posts[0].text.includes("Pareri contrari e ricorsi entro il 20/11/2026"))
  // Resuming didn't send the email again, and the records are the proof.
  assert.equal(emails.length, 1)
  const records = await db.select().from(notifications).where(eq(notifications.draftId, a.id))
  assert.deepEqual(records.map((r) => [r.channel, r.status, r.attempts]).sort(), [
    ["email", "sent", 1],
    ["telegram", "sent", 2],
  ])
  await rejects(emanation.retry(pres, a.id), "PRECONDITION_FAILED")
  await emanation.advance(a.id)
  assert.equal(emails.length + posts.length, 2)
  checked.push("a failed Telegram post resumes on retry; nothing is sent twice and every send is recorded")

  // ---- A rettifica on a delega, the same day as another emanation ----
  await service.createDelega(seg, { userId: "delegato", documentKey: "sample" })
  assert.deepEqual(emails.at(-1), { to: "direttivo@example.org", kind: "delega:created", attachments: 0 })
  const newest = (await service.listVersions(seg, "sample"))[0]
  assert.equal(newest.tag, "sample-v2026.11.09")
  const r = await service.createDraft(delegato, {
    documentKey: "sample",
    title: "Refusi",
    from: { kind: "version", id: newest.id },
    kind: "rettifica",
  })
  const rFiles = await text(r.id)
  await write(r.id, {
    ...rFiles,
    "parti/secondo.tex": rFiles["parti/secondo.tex"].replace("gestiti dagli Admin", "gestiti dagli admin"),
  })
  clock = new Date("2026-11-09T15:00:00Z")
  await emanation.start(delegato, r.id)
  await until("the rettifica is done", async () => (await emanation.get(delegato, r.id)).status === "done")
  const rv = await emanation.get(delegato, r.id)
  assert.equal(rv.tag, "sample-v2026.11.09.2")
  assert.ok(String(repo.files("main").get("sample/main.tex")).includes("\\rettifica[Davide Delegato]{2026-11-09}"))
  assert.ok(String(repo.files("main").get("sample/main.tex")).includes("\\approvazione{direttivo}{2026-11-09}"))
  const rd = await service.getDraft(delegato, r.id)
  assert.deepEqual(
    [rd.state, rd.delibera?.kind, rd.delibera?.kind === "rettifica" && rd.delibera.onBehalfOf?.id],
    ["emanata", "rettifica", "segretario"]
  )
  assert.ok(emails.some((e) => e.kind === "delega:used" && e.to === "segretario@example.org"))
  assert.ok(!posts.at(-1)?.text.includes("Pareri contrari"))
  checked.push(
    "a delegate's rettifica skips approval, says so in the sources, notifies the Segretario, and gets the .2 tag"
  )

  const [row] = await db.select().from(drafts).where(eq(drafts.id, r.id))
  assert.ok(row.frozenFiles)
  checked.push("the emanated text stays frozen")
  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
