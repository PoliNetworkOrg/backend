import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { blobs, diffs, documents, drafts, notifications, versions, ydocs } from "@/db/schema/regulations"
import type { CollabControl } from "@/regulations/collab/internal-client"
import { createYjsPersistence } from "@/regulations/collab/persistence"
import { decodeFiles, encodeFiles } from "@/regulations/collab/ydoc"
import type { AssetBundle } from "@/regulations/compile/protocol"
import type * as C from "@/regulations/contract"
import type { Files } from "@/regulations/contract"
import { REGULATION_PERMISSIONS as P } from "@/regulations/contract"
import { sha256 } from "@/regulations/db"
import { createDiffService } from "@/regulations/diff/service"
import type { DiffSummarizer } from "@/regulations/diff/summarizer"
import { createDirectory } from "@/regulations/directory"
import { fakeGitHub } from "@/regulations/emanation/github"
import { CREATION_GRACE_MS, createEmanationService, type EmanationNotifier } from "@/regulations/emanation/service"
import { parseDocument } from "@/regulations/latex"
import { appendDocumentEntry, localLegalSource } from "@/regulations/legal-source"
import { createRegulationsService, type Viewer } from "@/regulations/service"

/**
 * Documents beyond the RRI (Addendum 2026-11-22): documents.json v2 with templates, read-only documents, the
 * `documento` procedure (repository and private), private documents from a template and uploaded PDFs, repository
 * documents created through the App, and that nothing private ever reaches GitHub, the LLM, email or Telegram.
 */
const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres", max: 1 })
const databaseName = `regs_documents_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName, max: 4 })
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

const put = (root: string, path: string, content: string | Uint8Array) => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}
const bytes = (...values: number[]) => new Uint8Array(values)
const pdfBytes = (text: string) => new TextEncoder().encode(`%PDF-1.4\n% ${text}\n%%EOF\n`)

try {
  await migrate(db, { migrationsFolder: "./drizzle" })

  // A documents repository with the v2 layout: two templates, the RRI-like sample, a general document, a read-only one.
  const repo = mkdtempSync(join(tmpdir(), "regs-documents-"))
  cpSync(join(import.meta.dirname, "fixtures/regulations/sample"), join(repo, "rri"), { recursive: true })
  put(repo, "shared/regolamento/polinetwork-regolamento.cls", "% class\n")
  put(repo, "shared/regolamento/pandoc/filter.lua", "-- filter\n")
  put(repo, "shared/generale/polinetwork.cls", "% generale\n")
  put(repo, "shared/generale/fonts/DMSans-Regular.ttf", bytes(0, 1, 0, 0, 0xff, 0xfe))
  put(repo, "shared/generale/img/logo.png", bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff))
  put(repo, "shared/generale/main.aux", "build product\n")
  put(
    repo,
    "templates/regolamento/main.tex",
    "\\documentclass{polinetwork-regolamento}\n% {{TITLE}} {{KEY}} {{DATE}}\n"
  )
  put(repo, "templates/regolamento/regolamenti/parte.tex", "\\regolamento{{{TITLE}}}\n")
  put(repo, "templates/regolamento/latexmkrc", "ensure_path('TEXINPUTS', '../../shared/regolamento//');\n")
  put(
    repo,
    "templates/generale/{{KEY}}.tex",
    "\\documentclass{polinetwork}\n\\title{{{TITLE}}}\n\\date{{{DATE}}}\n\\begin{document}{{KEY}}\\end{document}\n"
  )
  put(repo, "templates/generale/immagine.png", bytes(1, 2, 3))
  put(repo, "generali/guida/guida.tex", "\\documentclass{polinetwork}\n\\begin{document}Guida\\end{document}\n")
  put(repo, "generali/guida/foto.png", bytes(9, 9, 9))
  put(repo, "statuto/main.tex", "\\documentclass{article}\n\\begin{document}Statuto v1\\end{document}\n")
  put(repo, "statuto/fonts/Ubuntu.ttf", bytes(7, 7))
  put(repo, "statuto/full.pdf", pdfBytes("statuto"))
  const manifest = {
    version: 2,
    templates: {
      regolamento: { title: "Regolamento", shared: "shared/regolamento", skeleton: "templates/regolamento" },
      generale: { title: "Documento generale", shared: "shared/generale", skeleton: "templates/generale" },
    },
    documents: [
      {
        key: "rri",
        title: "Raccolta",
        dir: "rri",
        entry: "main.tex",
        sources: ["main.tex", "parti/*.tex"],
        outputs: { pdf: "rri.pdf" },
        tagPrefix: "rri-",
        template: "regolamento",
        procedure: "rri",
      },
      {
        key: "guida",
        title: "Guida della matricola",
        dir: "generali/guida",
        entry: "guida.tex",
        sources: ["*.tex"],
        outputs: { pdf: "guida.pdf" },
        tagPrefix: "guida-",
        template: "generale",
        procedure: "documento",
      },
      {
        key: "statuto",
        title: "Statuto",
        dir: "statuto",
        entry: "main.tex",
        sources: ["main.tex"],
        outputs: { pdf: "statuto.pdf" },
        tagPrefix: "statuto-",
        template: null,
        procedure: null,
      },
    ],
  }
  const writeManifest = (m: unknown) => put(repo, "documents.json", JSON.stringify(m, null, 2))
  writeManifest(manifest)

  const people = [
    { sub: "segretario", name: "Sara Segretario", email: "segretario@example.org" },
    { sub: "direttivo", name: "Dario Direttivo", email: null },
    { sub: "lettore", name: "Laura Lettrice", email: null },
  ]
  const directory = createDirectory(async () => people)
  const grants: Record<string, string[]> = {
    segretario: [P.read, P.write, P.manage, P.rectify],
    direttivo: [P.read, P.write],
    lettore: [P.read],
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
  const reopened: string[] = []
  const collab: CollabControl = {
    text,
    replace: async (id, files) => {
      await write(id, files)
      return files
    },
    freeze: async (id) => {
      const files = await text(id)
      const [row] = await db
        .select({ entry: documents.entry })
        .from(drafts)
        .innerJoin(documents, eq(documents.key, drafts.documentKey))
        .where(eq(drafts.id, id))
      return { files, parses: parseDocument(files, row.entry).parses }
    },
    reopen: async (id) => {
      reopened.push(id)
    },
    broadcast: async () => {},
    refresh: async () => {},
  }
  // The worker, faked: a source containing \errore doesn't compile; every compile is recorded with its assets.
  const compiled: { id: string; entry: string; assets: AssetBundle }[] = []
  const compileVersion = async (version: { id: string; entry: string; files: Files; assets: string }) => {
    const [bundle] = await db.select().from(blobs).where(eq(blobs.hash, version.assets))
    compiled.push({
      id: version.id,
      entry: version.entry,
      assets: JSON.parse(Buffer.from(bundle.content).toString("utf8")),
    })
    if (Object.values(version.files).some((f) => f.includes("\\errore"))) return null
    const content = pdfBytes(`compiled ${version.id}`)
    const hash = sha256(content)
    await db.insert(blobs).values({ hash, contentType: "application/pdf", content }).onConflictDoNothing()
    await db.update(versions).set({ pdfBlob: hash }).where(eq(versions.id, version.id))
    return content
  }

  let clock = new Date("2026-11-10T10:00:00Z")
  const now = () => clock
  const service = createRegulationsService({
    db,
    directory,
    collab,
    collabUrl: "ws://x",
    legal: localLegalSource(repo),
    compileVersion,
    now,
  })
  // Nothing in this file may reach the LLM: the RRI isn't sent to approval here.
  const llmCalls: string[] = []
  const summarizer: DiffSummarizer = {
    provider: "spy",
    model: "spy",
    summarize: async (input) => {
      llmCalls.push(input.documentTitle)
      return []
    },
  }
  const diff = createDiffService({ db, regulations: service, summarizer, now })
  const github = fakeGitHub({
    files: { "documents.json": readFileSync(join(repo, "documents.json"), "utf8") },
    ciDelayMs: 50,
    releaseDelayMs: 50,
    buildRelease: async (tag) => [{ name: tag.startsWith("guida-") ? "guida.pdf" : "x.pdf", content: pdfBytes(tag) }],
  })
  const notices: string[] = []
  const notifier: EmanationNotifier = {
    email: async (input) => {
      notices.push(`email:${input.props.documentTitle}`)
    },
    delegaEmail: async (input) => {
      notices.push(`delega:${input.props.change}`)
    },
    telegram: async (payload) => {
      notices.push(`telegram:${payload.regulation.documentTitle}`)
      return { messageIds: [1] }
    },
  }
  const errors: unknown[] = []
  const emanation = createEmanationService({
    db,
    regulations: service,
    diff,
    github: github.client,
    collab,
    directory,
    notifier,
    config: {
      baseBranch: "main",
      emailTo: "soci@example.org",
      replyTo: "direttivo@example.org",
      direttivoEmail: "direttivo@example.org",
      telegram: { chatId: -1, topicId: null },
      webUrl: () => null,
      pollSeconds: 0,
    },
    onError: (error) => errors.push(error),
    now,
  })
  const until = async (what: string, fn: () => Promise<boolean>) => {
    for (let i = 0; i < 100; i++) {
      await emanation.tick()
      if (await fn()) return
      await wait(20)
    }
    throw new Error(`timed out: ${what}`)
  }
  const seg = await as("segretario")
  const dir = await as("direttivo")
  const lettore = await as("lettore")
  const bundleOf = async (hash: string | null) => {
    const [row] = await db
      .select()
      .from(blobs)
      .where(eq(blobs.hash, hash as string))
    return JSON.parse(Buffer.from(row.content).toString("utf8")) as AssetBundle
  }
  const versionOf = async (documentKey: string) =>
    (await db.select().from(versions).where(eq(versions.documentKey, documentKey))).sort(
      (a, b) => b.publishedAt.getTime() - a.publishedAt.getTime()
    )

  // ---------------------------------------------------------------------------------------------------------------
  // documents.json v2
  // ---------------------------------------------------------------------------------------------------------------
  const synced = await service.syncDocuments(seg)
  assert.deepEqual(synced, {
    documents: ["rri", "guida", "statuto"],
    imported: ["rri", "guida", "statuto"],
    updated: [],
    skipped: [],
  })
  const list = await service.listDocuments(lettore)
  const byKey = Object.fromEntries(list.map((d) => [d.key, d]))
  assert.deepEqual(
    list.map((d) => [d.key, d.kind, d.procedureKey, d.storage, d.template, d.editable]),
    [
      ["guida", "generale", "documento", "repo", "generale", true],
      ["rri", "regolamento", "rri", "repo", "regolamento", true],
      ["statuto", "consultazione", null, "repo", null, false],
    ]
  )
  assert.equal(byKey.statuto.procedure, null)
  assert.deepEqual(
    byKey.guida.procedure?.states.map((s) => s.key),
    ["bozza", "pubblicata"]
  )
  const guidaAssets = await bundleOf((await versionOf("guida"))[0].assetsBlob)
  assert.deepEqual(Object.keys(guidaAssets.files).sort(), [
    "foto.png",
    "shared/fonts/DMSans-Regular.ttf",
    "shared/img/logo.png",
    "shared/polinetwork.cls",
  ])
  assert.deepEqual(
    Buffer.from(guidaAssets.files["shared/fonts/DMSans-Regular.ttf"], "base64"),
    Buffer.from([0, 1, 0, 0, 0xff, 0xfe])
  )
  const rriAssets = await bundleOf((await versionOf("rri"))[0].assetsBlob)
  assert.deepEqual(
    Object.keys(rriAssets.files)
      .filter((p) => p.startsWith("shared/"))
      .sort(),
    ["shared/pandoc/filter.lua", "shared/polinetwork-regolamento.cls"]
  )
  const statutoAssets = await bundleOf((await versionOf("statuto"))[0].assetsBlob)
  assert.deepEqual(Object.keys(statutoAssets.files).sort(), ["fonts/Ubuntu.ttf", "full.pdf"])
  assert.deepEqual(
    (await service.listTemplates(lettore)).map((t) => [t.key, t.directory]),
    [
      ["regolamento", "regolamenti/"],
      ["generale", "generali/"],
    ]
  )
  checked.push("documents.json v2 imports every document with its template's whole shared tree under shared/")

  // A missing or invalid manifest is a clear refusal.
  writeManifest({ ...manifest, version: 1 })
  await rejects(service.syncDocuments(seg), "PRECONDITION_FAILED", /documents\.json non è valido \(version\)/)
  writeManifest({ ...manifest, documents: [{ ...manifest.documents[1], template: "inesistente" }] })
  await rejects(service.syncDocuments(seg), "PRECONDITION_FAILED", /template inesistente/)
  writeFileSync(join(repo, "documents.json"), "{")
  await rejects(service.syncDocuments(seg), "PRECONDITION_FAILED", /non è JSON valido/)
  const missing = createRegulationsService({
    db,
    directory,
    collab,
    collabUrl: null,
    legal: localLegalSource(tmpdir()),
  })
  await rejects(missing.syncDocuments(seg), "PRECONDITION_FAILED", /documents\.json non trovato/)
  writeManifest(manifest)
  checked.push("a missing or invalid documents.json is refused with a message that says why")

  // Assets that change in the repository heal the stored bundle, at boot and on sync.
  put(repo, "shared/generale/fonts/DMSans-Bold.ttf", bytes(5, 5, 5))
  assert.deepEqual(await service.refreshAssets(), { updated: ["guida"] })
  assert.equal("shared/fonts/DMSans-Bold.ttf" in (await bundleOf((await versionOf("guida"))[0].assetsBlob)).files, true)
  checked.push("a changed shared tree heals the stored assets")

  // ---------------------------------------------------------------------------------------------------------------
  // Sola consultazione
  // ---------------------------------------------------------------------------------------------------------------
  const statutoV1 = (await versionOf("statuto"))[0]
  await rejects(
    service.createDraft(seg, {
      documentKey: "statuto",
      title: "X",
      from: { kind: "version", id: statutoV1.id },
      kind: "modifica",
    }),
    "PRECONDITION_FAILED",
    /sola consultazione/
  )
  const statutoPdf = await service.versionPdf(lettore, statutoV1.id)
  assert.equal(Buffer.from(statutoPdf.base64, "base64").subarray(0, 5).toString(), "%PDF-")
  assert.equal(compiled.at(-1)?.entry, "main.tex")
  // Edited by hand in the repository: the next sync makes its head the version in force.
  clock = new Date("2026-11-10T11:00:00Z")
  put(repo, "statuto/main.tex", "\\documentclass{article}\n\\begin{document}Statuto v2\\end{document}\n")
  assert.deepEqual((await service.syncDocuments(seg)).updated, ["statuto"])
  const [statutoV2] = await versionOf("statuto")
  assert.notEqual(statutoV2.id, statutoV1.id)
  assert.equal(statutoV2.origin, "import")
  assert.match(statutoV2.files["main.tex"], /Statuto v2/)
  assert.deepEqual((await service.syncDocuments(seg)).updated, [])
  checked.push("read-only documents are imported with a PDF from the worker, follow the repository, and refuse drafts")

  // ---------------------------------------------------------------------------------------------------------------
  // Procedure documento, repository: published through the App like an emanation, without notices
  // ---------------------------------------------------------------------------------------------------------------
  const guidaV1 = (await versionOf("guida"))[0]
  await rejects(
    service.createDraft(seg, {
      documentKey: "guida",
      title: "R",
      from: { kind: "version", id: guidaV1.id },
      kind: "rettifica",
    }),
    "BAD_REQUEST",
    /solo per i documenti con la procedura dei regolamenti/
  )
  await rejects(service.createDelega(seg, { userId: "direttivo", documentKey: "guida" }), "BAD_REQUEST")
  const guidaDraft = await service.createDraft(dir, {
    documentKey: "guida",
    title: "Aggiornamento",
    from: { kind: "version", id: guidaV1.id },
    kind: "modifica",
  })
  await write(guidaDraft.id, {
    "guida.tex": "\\documentclass{polinetwork}\n\\begin{document}Guida 2027\\end{document}\n",
  })
  const asDir = await service.getDraft(dir, guidaDraft.id)
  assert.equal(asDir.can.emanate, false)
  assert.deepEqual(asDir.can.transitions, [])
  assert.equal(asDir.can.regenerateDiff, false)
  const asSeg = await service.getDraft(seg, guidaDraft.id)
  assert.equal(asSeg.can.emanate, true)
  assert.equal(asSeg.can.emanateBlockedBy, null)
  assert.equal(asSeg.procedure.transitions[0].label, "Pubblica")
  await rejects(emanation.start(dir, guidaDraft.id), "FORBIDDEN")
  await rejects(service.transition(seg, { draftId: guidaDraft.id, to: "pubblicata" }), "BAD_REQUEST", /Pubblica/)
  const startedGuida = await emanation.start(seg, guidaDraft.id)
  // No notice for a documento: skipped from the start, not left pending.
  assert.deepEqual(
    startedGuida.steps.filter((s) => s.key === "email" || s.key === "telegram").map((s) => [s.state, s.detail]),
    [
      ["skipped", "Nessuna notifica per questo documento"],
      ["skipped", "Nessuna notifica per questo documento"],
    ]
  )
  await until("guida published", async () => (await emanation.get(seg, guidaDraft.id)).status === "done")
  const published = await emanation.get(seg, guidaDraft.id)
  assert.equal(published.tag, "guida-v2026.11.10")
  assert.deepEqual(
    published.steps.map((s) => [s.key, s.state]),
    [
      ["pr", "done"],
      ["checks", "done"],
      ["merge", "done"],
      ["tag", "done"],
      ["release", "done"],
      ["email", "skipped"],
      ["telegram", "skipped"],
    ]
  )
  assert.match(github.files().get("generali/guida/guida.tex") as string, /Guida 2027/)
  assert.equal(github.prs[0].branch, `documenti/guida-${guidaDraft.id}`)
  assert.match(github.prs[0].body, /Pubblicato da Sara Segretario il 10\/11\/2026/)
  // No differences PDF attached: a documento has no LLM differences.
  assert.deepEqual(
    github.releases[0].assets.map((a) => a.name),
    ["guida.pdf"]
  )
  const guidaDone = await service.getDraft(seg, guidaDraft.id)
  assert.equal(guidaDone.state, "pubblicata")
  const [guidaV2] = await versionOf("guida")
  assert.equal(guidaV2.tag, "guida-v2026.11.10")
  assert.equal(guidaV2.origin, "draft")
  assert.equal(guidaV2.draftId, guidaDraft.id)
  assert.equal((await service.getDocument(lettore, "guida")).openDrafts, 0)
  assert.deepEqual(notices, [])
  assert.equal((await db.select().from(notifications)).length, 0)
  assert.equal((await db.select().from(diffs)).length, 0)
  await rejects(diff.generate(guidaDraft.id, seg.person), "PRECONDITION_FAILED")
  checked.push(
    "a repository documento is published by regulations:manage through the App, with no delibera, LLM or notice"
  )

  // The repository makes it read-only while it has only closed drafts: they still open, with the procedure they ran.
  writeManifest({
    ...manifest,
    documents: manifest.documents.map((d) => (d.key === "guida" ? { ...d, procedure: null } : d)),
  })
  await service.syncDocuments(seg)
  assert.equal((await service.getDocument(lettore, "guida")).kind, "consultazione")
  const closedView = await service.getDraft(seg, guidaDraft.id)
  assert.deepEqual(
    [closedView.state, closedView.procedure.key, closedView.can.emanate],
    ["pubblicata", "documento", false]
  )
  writeManifest(manifest)
  await service.syncDocuments(seg)
  assert.equal((await service.getDocument(lettore, "guida")).procedureKey, "documento")
  checked.push("a closed draft still opens after its document's procedure changed")

  // ---------------------------------------------------------------------------------------------------------------
  // Private documents from a template
  // ---------------------------------------------------------------------------------------------------------------
  const ghLog = () => [...github.log]
  const logBefore = ghLog()
  await rejects(
    service.createPrivateDocument(dir, { key: "verbali", title: "Verbali", template: "generale", storage: "private" }),
    "FORBIDDEN"
  )
  await rejects(
    service.createPrivateDocument(seg, { key: "guida", title: "Doppia", template: "generale", storage: "private" }),
    "CONFLICT"
  )
  await rejects(
    service.createPrivateDocument(seg, { key: "verbali", title: "V", template: "nessuno", storage: "private" }),
    "BAD_REQUEST"
  )
  const verbali = await service.createPrivateDocument(seg, {
    key: "verbali",
    title: "Verbali & note_riservate",
    template: "generale",
    storage: "private",
  })
  assert.deepEqual(
    [verbali.kind, verbali.storage, verbali.origin, verbali.procedureKey, verbali.template, verbali.editable],
    ["privato", "private", "latex", "documento", "generale", true]
  )
  assert.equal(verbali.latestVersion?.origin, "template")
  const [modello] = await versionOf("verbali")
  assert.deepEqual(Object.keys(modello.files), ["verbali.tex"])
  assert.match(modello.files["verbali.tex"], /\\title\{Verbali \\& note\\_riservate\}/)
  assert.match(modello.files["verbali.tex"], /\\date\{2026-11-10\}/)
  assert.match(modello.files["verbali.tex"], /\\begin\{document\}verbali\\end\{document\}/)
  assert.deepEqual(Object.keys((await bundleOf(modello.assetsBlob)).files).sort(), [
    "immagine.png",
    "shared/fonts/DMSans-Bold.ttf",
    "shared/fonts/DMSans-Regular.ttf",
    "shared/img/logo.png",
    "shared/polinetwork.cls",
  ])
  const [verbaliRow] = await db.select().from(documents).where(eq(documents.key, "verbali"))
  assert.equal(verbaliRow.entry, "verbali.tex")
  assert.equal(verbaliRow.dir, "")
  // Readable with regulations:read, and its PDF is compiled with the template's shared files.
  const modelloPdf = await service.versionPdf(lettore, modello.id)
  assert.equal(modelloPdf.contentType, "application/pdf")
  assert.equal(compiled.at(-1)?.entry, "verbali.tex")
  assert.equal("shared/polinetwork.cls" in (compiled.at(-1)?.assets.files ?? {}), true)

  const privateDraft = await service.createDraft(dir, {
    documentKey: "verbali",
    title: "Verbale di novembre",
    from: { kind: "version", id: modello.id },
    kind: "modifica",
  })
  // A text that doesn't compile can't be published: the version is dropped and the draft is editable again.
  await write(privateDraft.id, {
    "verbali.tex": "\\documentclass{polinetwork}\\begin{document}\\errore\\end{document}",
  })
  await rejects(emanation.start(seg, privateDraft.id), "PRECONDITION_FAILED", /non compila/)
  assert.equal((await versionOf("verbali")).length, 1)
  assert.equal((await service.getDraft(seg, privateDraft.id)).state, "bozza")
  assert.equal(reopened.includes(privateDraft.id), true)
  assert.equal((await db.select().from(drafts).where(eq(drafts.id, privateDraft.id)))[0].frozenFiles, null)
  await write(privateDraft.id, {
    "verbali.tex": "\\documentclass{polinetwork}\\begin{document}Riservato\\end{document}",
  })
  clock = new Date("2026-11-10T12:00:00Z")
  // Two "Pubblica" at once: one publishes, the other refuses; one version.
  const both = await Promise.allSettled([emanation.start(seg, privateDraft.id), emanation.start(seg, privateDraft.id)])
  assert.deepEqual(both.map((r) => r.status).sort(), ["fulfilled", "rejected"])
  const refusedTwin = both.find((r) => r.status === "rejected") as PromiseRejectedResult
  assert.match(String(refusedTwin.reason.code), /CONFLICT/)
  assert.equal((await versionOf("verbali")).length, 2)
  const privatePublished = (both.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<C.Emanation>).value
  assert.equal(privatePublished.status, "done")
  assert.equal(privatePublished.tag, null)
  assert.deepEqual(
    privatePublished.steps.map((s) => s.state),
    Array(7).fill("skipped")
  )
  const [verbaliV1] = await versionOf("verbali")
  assert.deepEqual(
    [verbaliV1.label, verbaliV1.origin, verbaliV1.tag, verbaliV1.draftId],
    ["v2026.11.10", "draft", null, privateDraft.id]
  )
  assert.match(verbaliV1.files["verbali.tex"], /Riservato/)
  assert.notEqual(verbaliV1.pdfBlob, null)
  assert.equal(verbaliV1.assetsBlob, modello.assetsBlob)
  const privateDone = await service.getDraft(seg, privateDraft.id)
  assert.equal(privateDone.state, "pubblicata")
  assert.equal(privateDone.versionId, verbaliV1.id)
  assert.equal(privateDone.can.edit, false)
  // A second publication the same day gets its own label.
  const second = await service.createDraft(dir, {
    documentKey: "verbali",
    title: "Correzione",
    from: { kind: "version", id: verbaliV1.id },
    kind: "modifica",
  })
  clock = new Date("2026-11-10T12:30:00Z")
  await emanation.start(seg, second.id)
  assert.equal((await versionOf("verbali"))[0].label, "v2026.11.10.2")
  // Nothing went out: no GitHub call, no LLM, no email or Telegram.
  assert.deepEqual(ghLog(), logBefore)
  assert.deepEqual(llmCalls, [])
  assert.deepEqual(notices, [])
  await rejects(diff.generate(privateDraft.id, seg.person), "PRECONDITION_FAILED")
  checked.push(
    "a private document from a template copies the skeleton and shared files, and publishes only into the DB"
  )

  // A manifest entry with a private document's key never overwrites it.
  writeManifest({
    ...manifest,
    documents: [...manifest.documents, { ...manifest.documents[1], key: "verbali", dir: "generali/guida" }],
  })
  const clash = await service.syncDocuments(seg)
  assert.deepEqual(clash.skipped, [{ key: "verbali", reason: "La chiave è già di un documento privato." }])
  assert.equal((await db.select().from(documents).where(eq(documents.key, "verbali")))[0].storage, "private")
  writeManifest(manifest)
  checked.push("sync never touches a private document")

  // ---------------------------------------------------------------------------------------------------------------
  // Uploaded PDFs
  // ---------------------------------------------------------------------------------------------------------------
  const file = (content: Uint8Array | string, name = "doc.pdf") =>
    new File([typeof content === "string" ? content : Buffer.from(content)], name)
  await rejects(
    service.uploadDocument(dir, { key: "bilancio", title: "Bilancio", file: file(pdfBytes("x")) }),
    "FORBIDDEN"
  )
  await rejects(
    service.uploadDocument(seg, { key: "bilancio", title: "Bilancio", file: file("not a pdf") }),
    "BAD_REQUEST",
    /non è un PDF/
  )
  await rejects(
    service.uploadDocument(seg, {
      key: "bilancio",
      title: "Bilancio",
      file: file(new Uint8Array(20 * 1024 * 1024 + 1)),
    }),
    "PAYLOAD_TOO_LARGE"
  )
  await rejects(service.uploadDocument(seg, { key: "statuto", title: "Doppio", file: file(pdfBytes("x")) }), "CONFLICT")
  // An upload doesn't depend on the repository: a broken manifest doesn't block it (the database still has its keys).
  writeFileSync(join(repo, "documents.json"), "{")
  await rejects(service.uploadDocument(seg, { key: "guida", title: "Doppio", file: file(pdfBytes("x")) }), "CONFLICT")
  const bilancio = await service.uploadDocument(seg, {
    key: "bilancio",
    title: "Bilancio 2026",
    file: file(pdfBytes("bilancio v1")),
  })
  assert.deepEqual(
    [bilancio.kind, bilancio.origin, bilancio.procedureKey, bilancio.procedure, bilancio.editable],
    ["privato", "upload", null, null, false]
  )
  writeManifest(manifest)
  assert.equal(bilancio.latestVersion?.origin, "upload")
  assert.equal(bilancio.latestVersion?.pdfAvailable, true)
  const servedPdf = await service.versionPdf(lettore, bilancio.latestVersion?.id as string)
  assert.match(Buffer.from(servedPdf.base64, "base64").toString(), /bilancio v1/)
  clock = new Date("2026-11-11T09:00:00Z")
  const bilancioV2 = await service.uploadVersion(seg, { documentKey: "bilancio", file: file(pdfBytes("bilancio v2")) })
  assert.equal(bilancioV2.label, "v2026.11.11")
  assert.equal((await service.getDocument(lettore, "bilancio")).latestVersion?.id, bilancioV2.id)
  await rejects(service.uploadVersion(seg, { documentKey: "verbali", file: file(pdfBytes("x")) }), "BAD_REQUEST")
  await rejects(
    service.createDraft(seg, {
      documentKey: "bilancio",
      title: "X",
      from: { kind: "version", id: bilancioV2.id },
      kind: "modifica",
    }),
    "PRECONDITION_FAILED",
    /PDF caricato/
  )
  assert.deepEqual(ghLog(), logBefore)
  checked.push("an uploaded PDF is a private read-only document; a new version is a new upload")

  // ---------------------------------------------------------------------------------------------------------------
  // New repository documents, through a pull request
  // ---------------------------------------------------------------------------------------------------------------
  await rejects(
    emanation.createDocument(dir, { key: "nuovo", title: "Nuovo", template: "regolamento", storage: "repo" }),
    "FORBIDDEN"
  )
  // "rri-x-" would be confused with the RRI's tags (rri-…) by the release workflow.
  await rejects(
    emanation.createDocument(seg, { key: "rri-x", title: "X", template: "regolamento", storage: "repo" }),
    "CONFLICT",
    /tag/
  )
  await rejects(
    emanation.createDocument(seg, { key: "bilancio", title: "X", template: "regolamento", storage: "repo" }),
    "CONFLICT"
  )
  const creating = await emanation.createDocument(seg, {
    key: "commissione",
    title: "Regolamento della Commissione",
    template: "regolamento",
    storage: "repo",
  })
  assert.equal(creating.status, "creating")
  assert.equal(creating.kind, "regolamento")
  assert.equal(creating.procedureKey, "documento")
  assert.equal(creating.editable, false)
  assert.equal(creating.creation?.prNumber, 2)
  const pr = github.prs[1]
  assert.match(pr.title, /Nuovo documento: Regolamento della Commissione/)
  // Fixed by hand on the pull request before it merges: the first version is what merged, not what was proposed.
  const fixedBranch = github.files(pr.branch)
  fixedBranch.set("regolamenti/commissione/regolamenti/parte.tex", "\\regolamento{Corretto a mano}\n")
  await until("creation merged", async () => (await service.getDocument(lettore, "commissione")).status === "active")
  const files = github.files()
  assert.match(
    files.get("regolamenti/commissione/main.tex") as string,
    /% Regolamento della Commissione commissione 2026-11-11/
  )
  assert.equal(files.get("regolamenti/commissione/regolamenti/parte.tex"), "\\regolamento{Corretto a mano}\n")
  // Other skeleton files are committed byte for byte.
  assert.match(
    new TextDecoder().decode(files.get("regolamenti/commissione/latexmkrc") as Uint8Array),
    /shared\/regolamento/
  )
  // documents.json keeps its formatting: the pull request only appends the entry.
  const originalManifest = readFileSync(join(repo, "documents.json"), "utf8")
  const cut = originalManifest.lastIndexOf("}", originalManifest.lastIndexOf("]")) + 1
  const committedText = files.get("documents.json") as string
  assert.equal(committedText.startsWith(originalManifest.slice(0, cut)), true)
  assert.equal(committedText.endsWith(originalManifest.slice(cut)), true)
  assert.match(committedText, /"sources": \["\*\.tex", "regolamenti\/\*\.tex"\]/)
  const committed = JSON.parse(committedText)
  assert.deepEqual(committed.documents.at(-1), {
    key: "commissione",
    title: "Regolamento della Commissione",
    dir: "regolamenti/commissione",
    entry: "main.tex",
    sources: ["*.tex", "regolamenti/*.tex"],
    outputs: { pdf: "commissione.pdf" },
    tagPrefix: "commissione-",
    template: "regolamento",
    procedure: "documento",
  })
  assert.equal(committed.documents.length, 4)
  const active = await service.getDocument(lettore, "commissione")
  assert.equal(active.editable, true)
  assert.equal(active.creation, null)
  assert.equal(active.latestVersion?.origin, "import")
  const [commissioneV1] = await versionOf("commissione")
  assert.deepEqual(Object.keys(commissioneV1.files).sort(), ["main.tex", "regolamenti/parte.tex"])
  assert.equal(commissioneV1.files["regolamenti/parte.tex"], "\\regolamento{Corretto a mano}\n")
  assert.equal(commissioneV1.commitSha, github.prs[1].mergeSha)
  assert.deepEqual(Object.keys((await bundleOf(commissioneV1.assetsBlob)).files).sort(), [
    "shared/pandoc/filter.lua",
    "shared/polinetwork-regolamento.cls",
  ])
  checked.push(
    "a repository document is created by a pull request from the template, then active with its first version"
  )

  // A closed pull request leaves it failed; the same key can be created again.
  const retried = await emanation.createDocument(seg, {
    key: "altro",
    title: "Altro",
    template: "generale",
    storage: "repo",
  })
  const altroPr = github.prs.find((p) => p.number === retried.creation?.prNumber)
  assert.ok(altroPr)
  Object.assign(altroPr, { state: "closed" })
  await until("creation failed", async () => (await service.getDocument(lettore, "altro")).status === "failed")
  assert.match((await service.getDocument(lettore, "altro")).creation?.error ?? "", /chiusa senza unirla/)
  await rejects(
    service.createDraft(seg, {
      documentKey: "altro",
      title: "X",
      from: { kind: "version", id: "none" },
      kind: "modifica",
    }),
    "PRECONDITION_FAILED",
    /in creazione/
  )
  const again = await emanation.createDocument(seg, {
    key: "altro",
    title: "Altro",
    template: "generale",
    storage: "repo",
  })
  assert.equal(again.status, "creating")
  assert.notEqual(again.creation?.prNumber, retried.creation?.prNumber)
  await until("second creation merged", async () => (await service.getDocument(lettore, "altro")).status === "active")
  assert.equal(github.files().has("generali/altro/altro.tex"), true)

  // A failed repository key can become a private document.
  const terzo = await emanation.createDocument(seg, {
    key: "terzo",
    title: "Terzo",
    template: "generale",
    storage: "repo",
  })
  Object.assign(github.prs.find((p) => p.number === terzo.creation?.prNumber) as object, { state: "closed" })
  await until("terzo failed", async () => (await service.getDocument(lettore, "terzo")).status === "failed")
  const terzoPrivate = await service.createPrivateDocument(seg, {
    key: "terzo",
    title: "Terzo privato",
    template: "generale",
    storage: "private",
  })
  assert.deepEqual([terzoPrivate.storage, terzoPrivate.status], ["private", "active"])
  checked.push("a failed creation's key can be reused, also for a private document")

  // A pull request that can't merge (a documents.json conflict) is reported, and resumes once resolved.
  const quarto = await emanation.createDocument(seg, {
    key: "quarto",
    title: "Quarto",
    template: "generale",
    storage: "repo",
  })
  const quartoPr = github.prs.find((p) => p.number === quarto.creation?.prNumber) as (typeof github.prs)[number]
  quartoPr.mergeable = false
  await until("conflict reported", async () =>
    /in conflitto/.test((await service.getDocument(lettore, "quarto")).creation?.error ?? "")
  )
  assert.equal((await service.getDocument(lettore, "quarto")).status, "creating")
  quartoPr.mergeable = true
  await until("quarto merged", async () => (await service.getDocument(lettore, "quarto")).status === "active")

  // The process stopped after opening the pull request but before saving its number: it's found by its branch.
  const lostBranch = "documenti/nuovo-perso-x"
  await github.client.commitToBranch({
    branch: lostBranch,
    base: "main",
    dir: "generali/perso",
    sourceGlobs: [],
    files: { "perso.tex": "\\documentclass{polinetwork}\\begin{document}Perso\\end{document}\n" },
    edits: [
      {
        path: "documents.json",
        update: (current) =>
          appendDocumentEntry(current as string, {
            key: "perso",
            title: "Perso",
            dir: "generali/perso",
            entry: "perso.tex",
            sources: ["*.tex"],
            outputs: { pdf: "perso.pdf" },
            tagPrefix: "perso-",
            template: "generale",
            procedure: "documento",
          }),
      },
    ],
    message: "perso",
  })
  await github.client.openPullRequest({ branch: lostBranch, base: "main", title: "Nuovo documento: Perso", body: "" })
  const orphan = (key: string, branch: string, startedAt: Date) =>
    db.insert(documents).values({
      key,
      title: key,
      dir: `generali/${key}`,
      entry: `${key}.tex`,
      sources: ["*.tex"],
      outputs: { pdf: `${key}.pdf` },
      tagPrefix: `${key}-`,
      procedure: "documento",
      template: "generale",
      status: "creating",
      creation: {
        branch,
        prNumber: null,
        prUrl: null,
        error: null,
        startedBy: seg.person,
        startedAt: startedAt.toISOString(),
        sources: {},
        assetsBlob: modello.assetsBlob as string,
      },
    })
  await orphan("perso", lostBranch, clock)
  await until(
    "lost pull request found and merged",
    async () => (await service.getDocument(lettore, "perso")).status === "active"
  )
  assert.match((await versionOf("perso"))[0].files["perso.tex"], /Perso/)
  // No pull request and no branch: failed after the grace period, or at once when the key is created again.
  await orphan("vecchio", "documenti/nuovo-vecchio-x", new Date(clock.getTime() - CREATION_GRACE_MS - 1000))
  await orphan("fermo", "documenti/nuovo-fermo-x", clock)
  await emanation.tick()
  assert.equal((await service.getDocument(lettore, "vecchio")).status, "failed")
  assert.equal((await service.getDocument(lettore, "fermo")).status, "creating")
  const fermo = await emanation.createDocument(seg, {
    key: "fermo",
    title: "Fermo",
    template: "generale",
    storage: "repo",
  })
  assert.equal(fermo.status, "creating")
  assert.notEqual(fermo.creation?.prNumber, null)
  checked.push("a creation stuck without a pull request or behind a conflict is recovered, reported or replaced")

  assert.deepEqual(notices, [])
  assert.deepEqual(llmCalls, [])
  assert.deepEqual(errors, [])
  checked.push("a failed creation can be started again with the same key")

  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`)
  await admin.close()
}
