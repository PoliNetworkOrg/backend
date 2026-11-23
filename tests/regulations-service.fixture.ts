import assert from "node:assert/strict"
import { cpSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { blobs, delibere, drafts, versions, ydocs } from "@/db/schema/regulations"
import type { CollabControl } from "@/regulations/collab/internal-client"
import { createYjsPersistence } from "@/regulations/collab/persistence"
import { decodeFiles, encodeFiles } from "@/regulations/collab/ydoc"
import type { Files } from "@/regulations/contract"
import { REGULATION_PERMISSIONS as P } from "@/regulations/contract"
import { createDiffService } from "@/regulations/diff/service"
import { fakeSummarizer } from "@/regulations/diff/summarizer"
import { createDirectory } from "@/regulations/directory"
import { parseDocument } from "@/regulations/latex"
import { localLegalSource } from "@/regulations/legal-source"
import { createRegulationsService, type RegulationsHooks, SECRET_BLOCK, type Viewer } from "@/regulations/service"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
// Small pools: the Postgres fixtures run in parallel against one server (100 connections).
const admin = new SQL({ ...connection, database: "postgres", max: 1 })
const databaseName = `regs_service_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName, max: 4 })
const db = drizzle({ client, schema })
const checked: string[] = []

async function rejects(promise: Promise<unknown>, code: string, message?: RegExp) {
  await assert.rejects(promise, (error: { code?: string; message?: string }) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    if (message) assert.match(error.message ?? "", message)
    return true
  })
}

try {
  await migrate(db, { migrationsFolder: "./drizzle" })

  // A legal checkout with the sample document.
  const legal = mkdtempSync(join(tmpdir(), "regs-legal-"))
  cpSync(join(import.meta.dirname, "fixtures/regulations/sample"), join(legal, "sample"), { recursive: true })
  cpSync(join(import.meta.dirname, "fixtures/regulations/sample"), join(legal, "shared/regolamento"), {
    recursive: true,
  })
  writeFileSync(join(legal, "shared/regolamento/polinetwork-regolamento.cls"), "% class\n")
  writeFileSync(
    join(legal, "documents.json"),
    JSON.stringify({
      version: 2,
      templates: {
        regolamento: { title: "Regolamento", shared: "shared/regolamento", skeleton: "templates/regolamento" },
      },
      documents: [
        {
          key: "sample",
          title: "Raccolta di prova",
          dir: "sample",
          entry: "main.tex",
          sources: ["main.tex", "parti/*.tex"],
          outputs: { pdf: "sample.pdf" },
          tagPrefix: "sample-",
          template: "regolamento",
          procedure: "rri",
        },
        {
          key: "manuale",
          title: "A mano",
          dir: "x",
          entry: "x.tex",
          sources: [],
          outputs: { pdf: "x.pdf" },
          tagPrefix: "x-",
          template: null,
          procedure: null,
        },
      ],
    })
  )

  const people = [
    { sub: "segretario", name: "Sara Segretario", email: "segretario@example.org" },
    { sub: "presidente", name: "Paolo Presidente", email: null },
    { sub: "direttivo", name: "Dario Direttivo", email: null },
    { sub: "editor", name: "Elena Editor", email: null },
    { sub: "commenter", name: "Carlo Commenter", email: null },
    { sub: "outsider", name: "Olga Outsider", email: null },
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

  // The collab service, faked over the stored Yjs state.
  const persistence = createYjsPersistence(db)
  const text = async (draftId: string) => decodeFiles((await persistence.load(draftId)) as Uint8Array)
  const write = async (draftId: string, files: Files) => {
    await db.delete(ydocs).where(eq(ydocs.draftId, draftId))
    await db.insert(ydocs).values({ draftId, state: encodeFiles(files), updatedAt: new Date() })
  }
  const broadcasts: string[] = []
  const collab: CollabControl = {
    text,
    replace: async (draftId, files) => {
      await write(draftId, files)
      return files
    },
    freeze: async (draftId) => {
      const files = await text(draftId)
      return { files, parses: parseDocument(files, "main.tex").parses }
    },
    reopen: async () => {},
    broadcast: async (_, message) => {
      broadcasts.push(String(message.type))
    },
    refresh: async () => {},
  }
  let clock = new Date("2026-11-10T10:00:00Z")
  const hooks: RegulationsHooks = {}
  const service = createRegulationsService({
    hooks,
    db,
    directory,
    collab,
    collabUrl: "ws://localhost:4100",
    legal: localLegalSource(legal),
    now: () => clock,
  })
  const diff = createDiffService({ db, regulations: service, summarizer: fakeSummarizer(), now: () => clock })
  hooks.sentToApproval = async (draftId, by) => {
    await diff.generate(draftId, by)
  }
  const seg = await as("segretario")
  const pres = await as("presidente")
  const dir = await as("direttivo")
  const editor = await as("editor")
  const commenter = await as("commenter")
  const outsider = await as("outsider")
  const delegato = await as("delegato")

  await rejects(service.syncDocuments(dir), "FORBIDDEN")
  const synced = await service.syncDocuments(seg)
  assert.deepEqual(synced, {
    documents: ["sample", "manuale"],
    imported: ["sample", "manuale"],
    updated: [],
    skipped: [],
  })
  assert.deepEqual((await service.syncDocuments(seg)).imported, [])
  const catalog = await service.listDocuments(dir)
  const doc = catalog.find((d) => d.key === "sample") as (typeof catalog)[number]
  assert.equal(doc.latestVersion?.label.startsWith("import"), true)
  assert.equal(doc.procedure?.states.length, 4)
  assert.equal(doc.kind, "regolamento")
  assert.equal(catalog.find((d) => d.key === "manuale")?.kind, "consultazione")
  await rejects(service.listDocuments(editor), "FORBIDDEN")
  checked.push("documents and the first version are imported from documents.json, once")

  // A version whose stored assets are wrong (fonts once read from GitHub as UTF-8 text) heals at the next boot.
  {
    const [imported] = await db.select().from(versions).where(eq(versions.documentKey, "sample"))
    const good = imported.assetsBlob as string
    const junk = (hash: string, type: string) =>
      db.insert(blobs).values({ hash, contentType: type, content: new Uint8Array([0xef, 0xbf, 0xbd]) })
    await junk("corrupted-assets", "application/json")
    await junk("stale-pdf", "application/pdf")
    const corrupt = () =>
      db
        .update(versions)
        .set({ assetsBlob: "corrupted-assets", pdfBlob: "stale-pdf" })
        .where(eq(versions.id, imported.id))
    const row = async () => (await db.select().from(versions).where(eq(versions.id, imported.id)))[0]
    await corrupt()
    assert.deepEqual(await service.refreshAssets(), { updated: ["sample"] })
    // The imported version compiles again from the repository's assets; its PDF was compiled here, so it's dropped.
    assert.equal((await row()).assetsBlob, good)
    assert.equal((await row()).pdfBlob, null)
    assert.deepEqual(await service.refreshAssets(), { updated: [] })
    // An emanated version keeps its release's official PDF.
    await db.update(versions).set({ tag: "sample-v2026.01.01" }).where(eq(versions.id, imported.id))
    await corrupt()
    assert.deepEqual(await service.refreshAssets(), { updated: ["sample"] })
    assert.equal((await row()).assetsBlob, good)
    assert.equal((await row()).pdfBlob, "stale-pdf")
    await db.update(versions).set({ tag: null, pdfBlob: null }).where(eq(versions.id, imported.id))
    // documents.sync repairs the same way.
    await corrupt()
    await service.syncDocuments(seg)
    assert.equal((await row()).assetsBlob, good)
    assert.equal((await row()).pdfBlob, null)
  }
  checked.push("stored assets that differ from the repository's are replaced at boot and on sync, dropping a stale PDF")

  const versionId = doc.latestVersion?.id as string
  await rejects(
    service.createDraft(editor, {
      documentKey: "sample",
      title: "X",
      from: { kind: "version", id: versionId },
      kind: "modifica",
    }),
    "FORBIDDEN"
  )
  const a = await service.createDraft(dir, {
    documentKey: "sample",
    title: "Bozza A",
    from: { kind: "version", id: versionId },
    kind: "modifica",
  })
  assert.equal(a.state, "bozza")
  assert.equal(a.myRole, "editor")
  assert.equal(a.parses, true)
  assert.equal(a.can.transitions[0]?.to, "in_approvazione")
  await service.setAssignment(dir, { draftId: a.id, userId: "editor", role: "editor" })
  await service.setAssignment(dir, { draftId: a.id, userId: "commenter", role: "commenter" })
  await rejects(service.setAssignment(editor, { draftId: a.id, userId: "outsider", role: "viewer" }), "FORBIDDEN")
  await rejects(service.setAssignment(dir, { draftId: a.id, userId: "nobody", role: "viewer" }), "NOT_FOUND")
  assert.equal((await service.listAssignments(editor, a.id)).length, 3)
  checked.push("the Direttivo creates drafts and assigns any IdP account; others can't")

  assert.equal((await service.me(editor)).assignedDrafts, 1)
  assert.deepEqual(
    (await service.listDrafts(editor, { includeClosed: false })).map((d) => d.id),
    [a.id]
  )
  const asEditor = await service.getDraft(editor, a.id)
  assert.equal(asEditor.myRole, "editor")
  assert.equal(asEditor.can.edit, true)
  assert.deepEqual(asEditor.can.transitions, [])
  const asCommenter = await service.getDraft(commenter, a.id)
  assert.deepEqual([asCommenter.myRole, asCommenter.can.edit, asCommenter.can.comment], ["commenter", false, true])
  assert.equal((await service.collabTicket(commenter, a.id)).readOnly, true)
  assert.equal((await service.collabTicket(editor, a.id)).readOnly, false)
  await rejects(service.getDraft(outsider, a.id), "NOT_FOUND")
  assert.equal((await service.me(outsider)).assignedDrafts, 0)
  checked.push("assignees see only their drafts, with capabilities from their role")

  const thread = await service.createComment(commenter, {
    draftId: a.id,
    anchor: { file: "parti/primo.tex", start: "AAAA", end: "AAAB" },
    quote: "le prove",
    body: "Serve chiarire.",
  })
  await service.replyComment(editor, { commentId: thread.id, body: "Fatto." })
  await service.resolveComment(editor, thread.id)
  const [listed] = await service.listComments(dir, a.id)
  assert.equal(listed.replies.length, 1)
  assert.equal(listed.resolvedBy?.id, "editor")
  await rejects(service.deleteComment(editor, thread.id), "FORBIDDEN")
  await service.deleteComment(commenter, thread.id)
  assert.equal((await service.listComments(dir, a.id))[0].deleted, true)
  checked.push("comments are threaded, resolvable, and deletable by their author")

  // Merge: B changes another comma (clean), C changes the same one (conflict).
  const b = await service.createDraft(dir, {
    documentKey: "sample",
    title: "Bozza B",
    from: { kind: "version", id: versionId },
    kind: "modifica",
  })
  const c = await service.createDraft(dir, {
    documentKey: "sample",
    title: "Bozza C",
    from: { kind: "version", id: versionId },
    kind: "modifica",
  })
  const base = await text(a.id)
  const edit = (files: Files, from: string, to: string) => ({
    ...files,
    "parti/primo.tex": files["parti/primo.tex"].replace(from, to),
  })
  await write(a.id, edit(base, "convocata dal Presidente", "convocata dal Presidente con preavviso"))
  await write(b.id, edit(base, "i due terzi", "i tre quarti"))
  await write(c.id, edit(base, "convocata dal Presidente", "convocata dal Segretario"))
  const clean = await service.previewMerge(dir, { targetDraftId: a.id, source: { kind: "draft", id: b.id } })
  assert.deepEqual([clean.blockedBy, clean.conflicts.length], [null, 0])
  await service.applyMerge(dir, { targetDraftId: a.id, source: { kind: "draft", id: b.id }, resolutions: {} })
  assert.ok((await text(a.id))["parti/primo.tex"].includes("i tre quarti"))
  const conflict = await service.previewMerge(dir, { targetDraftId: a.id, source: { kind: "draft", id: c.id } })
  assert.deepEqual(
    conflict.conflicts.map((x) => x.nodeId),
    ["com001"]
  )
  await rejects(
    service.applyMerge(dir, { targetDraftId: a.id, source: { kind: "draft", id: c.id }, resolutions: {} }),
    "PRECONDITION_FAILED",
    /conflitti/
  )
  await service.applyMerge(dir, {
    targetDraftId: a.id,
    source: { kind: "draft", id: c.id },
    resolutions: { com001: "theirs" },
  })
  assert.ok((await text(a.id))["parti/primo.tex"].includes("convocata dal Segretario"))
  // Merged again: the base is now C's text at the last merge, so nothing conflicts.
  assert.equal(
    (await service.previewMerge(dir, { targetDraftId: a.id, source: { kind: "draft", id: c.id } })).conflicts.length,
    0
  )
  await rejects(service.previewMerge(editor, { targetDraftId: a.id, source: { kind: "draft", id: b.id } }), "FORBIDDEN")
  checked.push("merges apply clean changes, require resolving conflicts, and remember the last merge as the base")

  const named = await service.createSnapshot(editor, { draftId: a.id, name: "Prima della revisione" })
  await write(a.id, edit(await text(a.id), "le prove", "le prove generali"))
  await service.restoreSnapshot(editor, named.id)
  assert.ok(!(await text(a.id))["parti/primo.tex"].includes("prove generali"))
  const kinds = (await service.listSnapshots(dir, a.id)).map((s) => s.kind)
  assert.ok(kinds.includes("base") && kinds.includes("merge") && kinds.filter((k) => k === "restore").length === 2)
  checked.push("named snapshots restore without losing the current text")

  // Files added in the editor: inside the document's sources, or a problem that blocks the approval.
  const beforeFiles = await text(a.id)
  await write(a.id, { ...beforeFiles, "parti/nuovo.tex": "% nuovo\n", "altro/x.tex": "% fuori\n" })
  const withStray = await service.draftFiles(editor, a.id)
  assert.deepEqual(withStray.sources, ["main.tex", "parti/*.tex"])
  assert.equal(withStray.structure.parses, false)
  assert.deepEqual(
    withStray.structure.issues.filter((i) => i.code === "stray_file").map((i) => i.file),
    ["altro/x.tex"]
  )
  await rejects(
    service.transition(dir, { draftId: a.id, to: "in_approvazione" }),
    "PRECONDITION_FAILED",
    /«altro\/x\.tex» non è tra i sorgenti/
  )
  await write(a.id, beforeFiles)
  checked.push("files outside the document's sources are a problem and block the approval")

  // Procedure.
  await rejects(service.transition(editor, { draftId: a.id, to: "in_approvazione" }), "FORBIDDEN")
  const sent = await service.transition(dir, { draftId: a.id, to: "in_approvazione" })
  assert.equal(sent.state, "in_approvazione")
  assert.equal(sent.can.edit, false)
  assert.equal((await service.collabTicket(editor, a.id)).readOnly, true)
  const [frozen] = await db.select().from(drafts).where(eq(drafts.id, a.id))
  assert.ok(frozen.frozenFiles?.["parti/primo.tex"].includes("convocata dal Segretario"))
  await rejects(
    service.transition(dir, { draftId: b.id, to: "in_approvazione" }),
    "CONFLICT",
    /già una bozza in approvazione/
  )
  assert.equal((await service.getDraft(dir, b.id)).can.transitions[0].blockedBy?.includes("Bozza A"), true)
  checked.push("sending to approval freezes the text, and only one draft per document can be in approval")

  await diff.settled(a.id)
  const generated = await diff.get(editor, a.id)
  assert.equal(generated.status, "ready")
  assert.equal(generated.provider, "fake")
  assert.deepEqual(
    generated.articles.filter((x) => x.kind === "modified").map((x) => x.id),
    ["art003", "art004"]
  )
  assert.ok(generated.categories.length > 0)
  assert.equal(
    Buffer.from((await diff.pdf(editor, a.id)).base64, "base64")
      .subarray(0, 4)
      .toString(),
    "%PDF"
  )
  assert.equal((await service.getDraft(dir, a.id)).diffStatus, "ready")
  await rejects(diff.regenerate(dir, a.id), "FORBIDDEN")
  const second = await diff.regenerate(pres, a.id)
  assert.equal(second.generation, 2)
  await diff.settled(a.id)
  assert.equal((await diff.get(pres, a.id)).status, "ready")
  checked.push("the LLM diff and the differences PDF are generated on approval, and managers can regenerate them")

  await rejects(
    service.transition(dir, {
      draftId: a.id,
      to: "approvata",
      delibera: { body: "consiglio_direttivo", date: "2026-11-09" },
    }),
    "FORBIDDEN"
  )
  await rejects(service.transition(pres, { draftId: a.id, to: "approvata" }), "BAD_REQUEST")
  await rejects(
    service.transition(pres, {
      draftId: a.id,
      to: "approvata",
      delibera: { body: "consiglio_direttivo", date: "2026-12-01" },
    }),
    "BAD_REQUEST",
    /futuro/
  )
  const approved = await service.transition(pres, {
    draftId: a.id,
    to: "approvata",
    delibera: { body: "consiglio_direttivo", date: "2026-11-09", verbaleUrl: "https://example.org/v.pdf" },
  })
  assert.equal(approved.state, "approvata")
  assert.equal(approved.delibera?.kind, "approvazione")
  assert.equal(approved.can.emanate, true)
  assert.deepEqual(
    approved.deadlines.map((d) => [d.key, d.dueAt, d.overdue]),
    [["emanazione", "2026-11-12T22:59:59.000Z", false]]
  )
  clock = new Date("2026-11-13T09:00:00Z")
  assert.equal((await service.getDraft(pres, a.id)).deadlines[0].overdue, true)
  assert.ok(broadcasts.includes("state"))
  checked.push("the approval records the delibera, and the 3-day emanation deadline turns overdue")

  // Back from approvata to bozza (regulations:manage): the delibera stops counting but stays in history.
  const withdrawRule = (await service.getDraft(pres, a.id)).can.transitions.find((t) => t.to === "bozza")
  assert.deepEqual(withdrawRule, {
    to: "bozza",
    label: "Riporta in bozza (annulla l'approvazione)",
    requires: [],
    blockedBy: null,
  })
  assert.equal(
    (await service.getDraft(dir, a.id)).can.transitions.some((t) => t.to === "bozza"),
    false
  )
  await rejects(service.transition(dir, { draftId: a.id, to: "bozza" }), "FORBIDDEN")
  const withdrawn = await service.transition(pres, { draftId: a.id, to: "bozza" })
  assert.deepEqual(
    [withdrawn.state, withdrawn.delibera, withdrawn.approvedAt, withdrawn.deadlines],
    ["bozza", null, null, []]
  )
  assert.equal((await service.getDraft(editor, a.id)).can.edit, true)
  const kept = await db.select().from(delibere).where(eq(delibere.draftId, a.id))
  assert.equal(kept.length, 1)
  assert.ok(kept[0].withdrawnAt)
  assert.equal(kept[0].withdrawnBy?.id, "presidente")
  assert.ok(
    (await service.listSnapshots(dir, a.id)).some(
      (x) => x.name === "Approvazione annullata (delibera del Consiglio Direttivo del 09/11/2026)"
    )
  )
  // It runs the procedure again; the new delibera is the current one.
  await service.transition(dir, { draftId: a.id, to: "in_approvazione" })
  const reapproved = await service.transition(pres, {
    draftId: a.id,
    to: "approvata",
    delibera: { body: "assemblea", date: "2026-11-12" },
  })
  assert.equal(reapproved.delibera?.kind === "approvazione" && reapproved.delibera.body, "assemblea")
  assert.equal((await db.select().from(delibere).where(eq(delibere.draftId, a.id))).length, 2)
  checked.push(
    "an approved draft can go back to bozza: editable again, its delibera kept as history, then approved anew"
  )

  // Deleghe and rettifica.
  await rejects(service.createDelega(dir, { userId: "delegato" }), "FORBIDDEN")
  await rejects(
    service.createDraft(delegato, {
      documentKey: "sample",
      title: "Refusi",
      from: { kind: "version", id: versionId },
      kind: "rettifica",
    }),
    "FORBIDDEN"
  )
  const delega = await service.createDelega(seg, { userId: "delegato", documentKey: "sample", note: "Refusi" })
  assert.equal(delega.active, true)
  const meDelegato = await service.me(delegato)
  assert.deepEqual([meDelegato.deleghe, meDelegato.rectifiable[0]?.latestVersionId], [1, versionId])
  await rejects(
    service.createDraft(delegato, {
      documentKey: "sample",
      title: "X",
      from: { kind: "version", id: versionId },
      kind: "modifica",
    }),
    "FORBIDDEN"
  )
  const r = await service.createDraft(delegato, {
    documentKey: "sample",
    title: "Refusi",
    from: { kind: "version", id: versionId },
    kind: "rettifica",
  })
  assert.deepEqual(
    [r.kind, r.myRole, r.can.emanate, r.can.rectify, r.can.transitions.length],
    ["rettifica", "editor", true, true, 0]
  )
  assert.equal((await service.listDeleghe(delegato)).length, 1)
  await service.revokeDelega(seg, delega.id)
  await rejects(
    service.createDraft(delegato, {
      documentKey: "sample",
      title: "Ancora",
      from: { kind: "version", id: versionId },
      kind: "rettifica",
    }),
    "FORBIDDEN"
  )
  assert.equal((await service.getDraft(delegato, r.id)).can.emanate, false)
  checked.push("a delega lets its holder start and emanate rettifiche until it is revoked")

  // Secret drafts: only the creator and the members they add, out of the procedure until made visible.
  {
    const openBefore = (await service.getDocument(seg, "sample")).openDrafts
    const secret = await service.createDraft(dir, {
      documentKey: "sample",
      title: "Segreta",
      from: { kind: "version", id: versionId },
      kind: "modifica",
      secret: true,
    })
    assert.deepEqual([secret.secret, secret.myRole, secret.can.reveal, secret.can.assign], [true, "editor", true, true])
    assert.ok(secret.can.transitions.length > 0)
    assert.ok(secret.can.transitions.every((t) => t.blockedBy === SECRET_BLOCK))
    for (const other of [seg, pres, editor]) await rejects(service.getDraft(other, secret.id), "NOT_FOUND")
    assert.equal(
      (await service.listDrafts(seg, { includeClosed: true })).some((d) => d.id === secret.id),
      false
    )
    assert.equal((await service.getDocument(seg, "sample")).openDrafts, openBefore)
    await rejects(service.setAssignment(seg, { draftId: secret.id, userId: "segretario", role: "editor" }), "NOT_FOUND")
    await service.setAssignment(dir, { draftId: secret.id, userId: "presidente", role: "commenter" })
    const asMember = await service.getDraft(pres, secret.id)
    assert.deepEqual(
      [asMember.myRole, asMember.can.edit, asMember.can.reveal, asMember.can.assign, asMember.can.delete],
      ["commenter", false, false, false, false]
    )
    await rejects(service.setAssignment(pres, { draftId: secret.id, userId: "editor", role: "viewer" }), "FORBIDDEN")
    await rejects(service.revealDraft(pres, secret.id), "FORBIDDEN")
    await rejects(service.deleteDraft(pres, secret.id), "FORBIDDEN")
    await rejects(service.removeAssignment(dir, { draftId: secret.id, userId: "direttivo" }), "BAD_REQUEST")
    await rejects(
      service.transition(dir, { draftId: secret.id, to: "in_approvazione" }),
      "PRECONDITION_FAILED",
      /segreta/
    )
    // A draft from a secret draft would show its text: it is secret too.
    const child = await service.createDraft(dir, {
      documentKey: "sample",
      title: "Figlia",
      from: { kind: "draft", id: secret.id },
      kind: "modifica",
    })
    assert.equal(child.secret, true)
    await rejects(
      service.createDraft(pres, {
        documentKey: "sample",
        title: "Da fuori",
        from: { kind: "draft", id: child.id },
        kind: "modifica",
      }),
      "NOT_FOUND"
    )

    const revealed = await service.revealDraft(dir, secret.id)
    assert.deepEqual([revealed.secret, revealed.can.reveal], [false, false])
    assert.ok(revealed.can.transitions.every((t) => t.blockedBy !== SECRET_BLOCK))
    assert.equal((await service.getDraft(seg, secret.id)).myRole, "editor")
    assert.equal((await service.getDocument(seg, "sample")).openDrafts, openBefore + 1)
    await rejects(service.revealDraft(dir, secret.id), "PRECONDITION_FAILED")
    await rejects(service.getDraft(seg, child.id), "NOT_FOUND")
    await service.deleteDraft(dir, child.id)
    await service.deleteDraft(dir, secret.id)
  }
  checked.push("secret drafts are seen only by their creator and chosen members, and move only once made visible")

  await rejects(service.deleteDraft(editor, b.id), "NOT_FOUND")
  await service.deleteDraft(dir, b.id)
  await rejects(service.getDraft(dir, b.id), "NOT_FOUND")
  checked.push("drafts are soft-deleted by the Direttivo")
  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
