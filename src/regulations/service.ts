import { TRPCError } from "@trpc/server"
import { and, asc, count, desc, eq, gt, inArray, isNull, or } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  assignments,
  blobs,
  comments,
  deleghe,
  delibere,
  diffs,
  documents,
  drafts,
  emanations,
  merges,
  snapshots,
  versions,
  ydocs,
} from "@/db/schema/regulations"
import type { CollabControl } from "./collab/internal-client"
import { createYjsPersistence, saveSnapshot } from "./collab/persistence"
import { issueTicket } from "./collab/tickets"
import { decodeFiles, encodeFiles } from "./collab/ydoc"
import { bundleHash, sourceHash } from "./compile/protocol"
import { readCompilePdf, readCompileStatus } from "./compile/store-pg"
import type * as C from "./contract"
import { REGULATION_PERMISSIONS as P } from "./contract"
import type { RegulationsDb } from "./db"
import type { Directory } from "./directory"
import { isEditable } from "./draft-context"
import { merge3, parseDocument, structureOf } from "./latex"
import type { LegalSource } from "./legal-source"
import { deadlineAt, procedureOf, procedureView, type TransitionRule } from "./procedure"

/** The signed-in dashboard user. */
export type Viewer = { sub: string; can: (permission: string) => boolean; person: C.PersonRef }

type DraftRow = typeof drafts.$inferSelect
type DocumentRow = typeof documents.$inferSelect

/** Refusals carry an Italian message the dashboard shows as-is. */
export function fail(code: TRPCError["code"], message: string): never {
  throw new TRPCError({ code, message })
}

export type RegulationsHooks = {
  /** A draft was sent to approval (generate the LLM diff). */
  sentToApproval?: (draftId: string, by: C.PersonRef) => Promise<void>
  /** A delega was created or revoked (email the Direttivo). */
  delegaChanged?: (delegaId: string, change: "created" | "revoked") => Promise<void>
}

export type RegulationsDeps = {
  db: RegulationsDb
  directory: Directory
  /** The collab service; without it the stored Yjs state is read directly and drafts can't be frozen live. */
  collab: CollabControl | null
  /** Public websocket URL of the collab service, for tickets. */
  collabUrl: string | null
  legal: LegalSource | null
  /** Compiles a published version's PDF when there is no official one yet. */
  compileVersion?: (version: {
    id: string
    entry: string
    files: C.Files
    assets: string
  }) => Promise<Uint8Array | null>
  hooks?: RegulationsHooks
  now?: () => Date
}

const iso = (d: Date | null | undefined) => d?.toISOString() ?? null
const day = (value: string | Date) => (value instanceof Date ? value.toISOString().slice(0, 10) : value)
const ROLE_RANK: Record<C.DraftRole, number> = { viewer: 0, commenter: 1, editor: 2 }

export function createRegulationsService(deps: RegulationsDeps) {
  const { db, directory } = deps
  const now = deps.now ?? (() => new Date())
  const persistence = createYjsPersistence(db)

  // ------------------------------------------------------------------------------------------------------------------
  // Access
  // ------------------------------------------------------------------------------------------------------------------

  async function activeDeleghe(sub: string) {
    return db
      .select()
      .from(deleghe)
      .where(
        and(
          eq(deleghe.granteeSub, sub),
          isNull(deleghe.revokedAt),
          or(isNull(deleghe.expiresAt), gt(deleghe.expiresAt, now()))
        )
      )
  }

  /** The Segretario's permission, or an active delega covering the document. */
  async function rectifyRight(viewer: Viewer, documentKey: string) {
    if (viewer.can(P.rectify)) return { delega: null }
    const delega = (await activeDeleghe(viewer.sub)).find(
      (d) => d.documentKey === null || d.documentKey === documentKey
    )
    return delega ? { delega } : null
  }

  async function assignmentOf(draftId: string, sub: string) {
    const [row] = await db
      .select()
      .from(assignments)
      .where(and(eq(assignments.draftId, draftId), eq(assignments.userSub, sub)))
    return row ?? null
  }

  async function roleOf(viewer: Viewer, draft: DraftRow): Promise<C.DraftRole | null> {
    if (viewer.can(P.write)) return "editor"
    const assigned = (await assignmentOf(draft.id, viewer.sub))?.role ?? null
    if (viewer.can(P.read)) return assigned && ROLE_RANK[assigned] > 0 ? assigned : "viewer"
    return assigned
  }

  async function loadDraft(draftId: string): Promise<DraftRow> {
    const [draft] = await db.select().from(drafts).where(eq(drafts.id, draftId))
    if (!draft || draft.deletedAt) fail("NOT_FOUND", "Bozza non trovata.")
    return draft
  }

  async function loadDocument(key: string): Promise<DocumentRow> {
    const [document] = await db.select().from(documents).where(eq(documents.key, key))
    if (!document) fail("NOT_FOUND", "Documento non trovato.")
    return document
  }

  /** The draft and the caller's role, at least `min`. Drafts the caller can't see don't exist for them. */
  async function access(viewer: Viewer, draftId: string, min: C.DraftRole = "viewer") {
    const draft = await loadDraft(draftId)
    const role = await roleOf(viewer, draft)
    if (!role) fail("NOT_FOUND", "Bozza non trovata.")
    if (ROLE_RANK[role] < ROLE_RANK[min])
      fail(
        "FORBIDDEN",
        min === "editor" ? "Serve il ruolo di editor su questa bozza." : "Serve almeno il ruolo di commentatore."
      )
    return { draft, role }
  }

  function requirePermission(viewer: Viewer, permission: string, message: string) {
    if (!viewer.can(permission)) fail("FORBIDDEN", message)
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Text
  // ------------------------------------------------------------------------------------------------------------------

  /** The draft's current text: frozen, live from the collab service, or from the stored Yjs state. */
  async function currentFiles(draft: DraftRow): Promise<C.Files> {
    if (draft.frozenFiles) return draft.frozenFiles
    if (deps.collab) return deps.collab.text(draft.id)
    const state = await persistence.load(draft.id)
    return state ? decodeFiles(state) : draft.baseFiles
  }

  async function versionRow(id: string) {
    const [version] = await db.select().from(versions).where(eq(versions.id, id))
    if (!version) fail("NOT_FOUND", "Versione non trovata.")
    return version
  }

  /** The published version a draft's lineage starts from. */
  /**
   * Why the draft can't go forward because a newer version was published after it started (it would undo it), or
   * null. A draft is current when the latest version is the one its lineage starts from, or was merged into it (or
   * into a draft it descends from).
   */
  async function supersededReason(draft: DraftRow): Promise<string | null> {
    const [latest] = await db
      .select()
      .from(versions)
      .where(eq(versions.documentKey, draft.documentKey))
      .orderBy(desc(versions.publishedAt))
      .limit(1)
    if (!latest || latest.draftId === draft.id) return null
    let cursor: DraftRow | undefined = draft
    for (let depth = 0; cursor && depth < 50; depth++) {
      if (cursor.baseVersionId === latest.id) return null
      const [merged] = await db
        .select({ id: merges.id })
        .from(merges)
        .where(
          and(eq(merges.targetDraftId, cursor.id), eq(merges.sourceKind, "version"), eq(merges.sourceId, latest.id))
        )
        .limit(1)
      if (merged) return null
      if (!cursor.baseDraftId) break
      ;[cursor] = await db.select().from(drafts).where(eq(drafts.id, cursor.baseDraftId))
    }
    const root = await rootVersion(draft)
    return `La bozza parte da una versione superata (${root.label}): unisci prima la versione in vigore ${latest.label}.`
  }

  async function rootVersion(draft: DraftRow) {
    let cursor: DraftRow = draft
    for (let depth = 0; depth < 50; depth++) {
      if (cursor.baseVersionId) return versionRow(cursor.baseVersionId)
      if (!cursor.baseDraftId) break
      const [parent] = await db.select().from(drafts).where(eq(drafts.id, cursor.baseDraftId))
      if (!parent) break
      cursor = parent
    }
    fail("PRECONDITION_FAILED", "La bozza non discende da nessuna versione pubblicata.")
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------------------------------------------------------

  async function versionSummary(row: typeof versions.$inferSelect): Promise<C.VersionSummary> {
    let delibera: C.Delibera | null = null
    if (row.draftId) {
      const [d] = await db.select().from(delibere).where(eq(delibere.draftId, row.draftId))
      if (d) delibera = deliberaView(d)
    }
    return {
      id: row.id,
      documentKey: row.documentKey,
      tag: row.tag,
      label: row.label,
      delibera,
      publishedAt: row.publishedAt.toISOString(),
      releaseUrl: row.releaseUrl,
      pdfAvailable: row.pdfBlob !== null || (!!deps.compileVersion && row.assetsBlob !== null),
      draftId: row.draftId,
    }
  }

  function deliberaView(d: typeof delibere.$inferSelect): C.Delibera {
    if (d.kind === "approvazione")
      return {
        kind: "approvazione",
        body: d.body as C.DeliberaBody,
        date: day(d.date),
        verbaleUrl: d.verbaleUrl,
        recordedBy: d.recordedBy,
        recordedAt: d.recordedAt.toISOString(),
      }
    return {
      kind: "rettifica",
      date: day(d.date),
      rectifiedBy: d.recordedBy,
      onBehalfOf: d.onBehalfOf,
      delegaId: d.delegaId,
    }
  }

  async function baseOf(draft: DraftRow): Promise<C.DraftBase> {
    if (draft.baseVersionId) {
      const [v] = await db.select({ label: versions.label }).from(versions).where(eq(versions.id, draft.baseVersionId))
      return { kind: "version", id: draft.baseVersionId, label: v?.label ?? draft.baseVersionId }
    }
    const [d] = await db
      .select({ title: drafts.title })
      .from(drafts)
      .where(eq(drafts.id, draft.baseDraftId as string))
    return { kind: "draft", id: draft.baseDraftId as string, title: d?.title ?? "" }
  }

  async function summary(draft: DraftRow, role: C.DraftRole): Promise<C.DraftSummary> {
    return {
      id: draft.id,
      documentKey: draft.documentKey,
      title: draft.title,
      kind: draft.kind,
      state: draft.state,
      base: await baseOf(draft),
      myRole: role,
      createdBy: draft.createdBy,
      createdAt: draft.createdAt.toISOString(),
      updatedAt: draft.updatedAt.toISOString(),
      stateChangedAt: draft.stateChangedAt.toISOString(),
      parses: draft.parses,
    }
  }

  async function diffStatusOf(draftId: string): Promise<C.Draft["diffStatus"]> {
    const [d] = await db
      .select({ status: diffs.status })
      .from(diffs)
      .where(eq(diffs.draftId, draftId))
      .orderBy(desc(diffs.generation))
      .limit(1)
    return d?.status ?? "none"
  }

  async function emanationOf(draftId: string) {
    const [e] = await db.select().from(emanations).where(eq(emanations.draftId, draftId))
    return e ?? null
  }

  async function inApproval(documentKey: string, except?: string) {
    const [row] = await db
      .select({ id: drafts.id, title: drafts.title })
      .from(drafts)
      .where(and(eq(drafts.documentKey, documentKey), eq(drafts.state, "in_approvazione"), isNull(drafts.deletedAt)))
    return row && row.id !== except ? row : null
  }

  function allowed(viewer: Viewer, who: TransitionRule["who"], rectify: boolean) {
    if (who === "write") return viewer.can(P.write)
    if (who === "manage") return viewer.can(P.manage)
    return rectify
  }

  async function draftView(viewer: Viewer, draft: DraftRow, role: C.DraftRole): Promise<C.Draft> {
    const document = await loadDocument(draft.documentKey)
    const config = procedureOf(document.procedure)
    const [deliberaRow] = await db.select().from(delibere).where(eq(delibere.draftId, draft.id))
    const emanation = await emanationOf(draft.id)
    const diffStatus = await diffStatusOf(draft.id)
    const rectify = (await rectifyRight(viewer, draft.documentKey)) !== null
    const editable = isEditable(draft) && !emanation
    const other = await inApproval(draft.documentKey, draft.id)
    const versionId = emanation?.versionId ?? null
    // Only drafts still on their way: an emanated one is the latest version itself.
    const superseded = draft.state === "emanata" || emanation ? null : await supersededReason(draft)

    const transitions: C.Capabilities["transitions"] = []
    for (const rule of config.transitions) {
      if (rule.from !== draft.state || !rule.kinds.includes(draft.kind) || rule.effect === "emanate") continue
      if (!allowed(viewer, rule.who, rectify)) continue
      let blockedBy: string | null = null
      if (rule.requires.includes("parses") && draft.parses === false)
        blockedBy = "Il testo non è valido: correggi gli errori prima."
      if (rule.to === "in_approvazione" && other) blockedBy = `C'è già una bozza in approvazione: «${other.title}».`
      if (rule.effect === "freeze" && superseded) blockedBy = superseded
      if (emanation) blockedBy = "L'emanazione è in corso."
      transitions.push({
        to: rule.to,
        label: rule.label,
        requires: rule.requires.includes("delibera") ? ["delibera"] : [],
        blockedBy,
      })
    }
    const emanateRule = config.transitions.find(
      (r) => r.effect === "emanate" && r.from === draft.state && r.kinds.includes(draft.kind)
    )
    let emanateBlockedBy: string | null = null
    if (emanateRule && !emanation && allowed(viewer, emanateRule.who, rectify)) {
      if (superseded) emanateBlockedBy = superseded
      else if (draft.kind === "rettifica" && draft.parses === false)
        emanateBlockedBy = "Il testo non è valido: correggi gli errori prima di emanare."
      else if (draft.kind === "modifica" && diffStatus !== "ready")
        emanateBlockedBy =
          diffStatus === "pending"
            ? "Le differenze sono ancora in generazione."
            : "Mancano le differenze: generale prima di emanare."
    }
    const emanate = !!emanateRule && !emanation && allowed(viewer, emanateRule.who, rectify) && !emanateBlockedBy

    const deadlines: C.Deadline[] = []
    for (const rule of config.deadlines) {
      if (!rule.states.includes(draft.state) || !rule.kinds.includes(draft.kind)) continue
      const start =
        rule.from === "delibera"
          ? deliberaRow
            ? day(deliberaRow.date)
            : null
          : draft.notifiedAt
            ? new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(draft.notifiedAt)
            : null
      if (!start) continue
      const due = deadlineAt(start, rule.days)
      deadlines.push({
        key: rule.key,
        label: rule.label,
        dueAt: due.toISOString(),
        severity: rule.severity,
        overdue: rule.severity === "warning" && now() > due && !draft.emanatedAt && !emanation,
      })
    }

    return {
      ...(await summary(draft, role)),
      can: {
        edit: role === "editor" && editable,
        comment: ROLE_RANK[role] >= ROLE_RANK.commenter && draft.state !== "emanata",
        assign: viewer.can(P.write) && draft.state !== "emanata",
        merge: viewer.can(P.write) && editable,
        transitions,
        approve: transitions.some((t) => t.to === "approvata" && !t.blockedBy),
        emanate,
        emanateBlockedBy,
        rectify,
        regenerateDiff:
          viewer.can(P.manage) &&
          (diffStatus === "ready" ||
            diffStatus === "failed" ||
            (diffStatus === "none" && draft.state === "approvata")) &&
          !draft.notifiedAt &&
          !emanation,
        delete:
          (viewer.can(P.write) || (draft.kind === "rettifica" && draft.createdBy.id === viewer.sub)) &&
          draft.state === "bozza" &&
          !emanation,
        rename: role === "editor" && draft.state !== "emanata",
        snapshot: role === "editor",
        restore: role === "editor" && editable,
      },
      procedure: procedureView(config),
      deadlines,
      delibera: deliberaRow ? deliberaView(deliberaRow) : null,
      diffStatus,
      emanationStatus: emanation?.status ?? "none",
      versionId,
      approvedAt: iso(draft.approvedAt),
      emanatedAt: iso(draft.emanatedAt),
      notifiedAt: iso(draft.notifiedAt),
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Me, users, documents, versions
  // ------------------------------------------------------------------------------------------------------------------

  async function latestVersion(documentKey: string) {
    const [row] = await db
      .select()
      .from(versions)
      .where(eq(versions.documentKey, documentKey))
      .orderBy(desc(versions.publishedAt))
      .limit(1)
    return row ?? null
  }

  async function me(viewer: Viewer): Promise<C.Me> {
    const [{ assigned }] = await db
      .select({ assigned: count() })
      .from(assignments)
      .innerJoin(drafts, eq(drafts.id, assignments.draftId))
      .where(and(eq(assignments.userSub, viewer.sub), isNull(drafts.deletedAt)))
    const held = await activeDeleghe(viewer.sub)
    const all = await db.select().from(documents).orderBy(asc(documents.key))
    const scope = viewer.can(P.rectify)
      ? all
      : all.filter((d) => held.some((h) => h.documentKey === null || h.documentKey === d.key))
    const rectifiable = []
    for (const document of scope) {
      const latest = await latestVersion(document.key)
      rectifiable.push({
        documentKey: document.key,
        title: document.title,
        latestVersionId: latest?.id ?? null,
        latestVersionLabel: latest?.label ?? null,
      })
    }
    return {
      assignedDrafts: assigned,
      deleghe: held.length,
      permissions: {
        read: viewer.can(P.read),
        write: viewer.can(P.write),
        manage: viewer.can(P.manage),
        rectify: viewer.can(P.rectify),
      },
      rectifiable,
    }
  }

  async function documentView(row: DocumentRow): Promise<C.DocumentInfo> {
    const latest = await latestVersion(row.key)
    const [{ open }] = await db
      .select({ open: count() })
      .from(drafts)
      .where(
        and(
          eq(drafts.documentKey, row.key),
          isNull(drafts.deletedAt),
          inArray(drafts.state, ["bozza", "in_approvazione", "approvata"])
        )
      )
    return {
      key: row.key,
      title: row.title,
      tagPrefix: row.tagPrefix,
      procedure: procedureView(procedureOf(row.procedure)),
      latestVersion: latest ? await versionSummary(latest) : null,
      openDrafts: open,
      inApproval: await inApproval(row.key),
    }
  }

  /** Imports legal.json and, for a document without versions, its current sources as the first published version. */
  async function syncDocuments(viewer: Viewer) {
    requirePermission(viewer, P.manage, "Serve il permesso regulations:manage.")
    if (!deps.legal) fail("PRECONDITION_FAILED", "Il repository legal non è configurato.")
    const manifest = await deps.legal.manifest()
    const head = await deps.legal.head()
    const imported: string[] = []
    for (const doc of manifest.documents) {
      if (!doc.procedure) continue
      procedureOf(doc.procedure)
      const values = {
        title: doc.title,
        dir: doc.dir,
        entry: doc.entry,
        sources: doc.sources,
        outputs: doc.outputs,
        tagPrefix: doc.tagPrefix,
        procedure: doc.procedure,
        updatedAt: now(),
      }
      await db
        .insert(documents)
        .values({ key: doc.key, ...values })
        .onConflictDoUpdate({ target: documents.key, set: values })
      const { sources, assets } = await deps.legal.readDocument(doc, manifest.shared)
      const assetsHash = await bundleHash(assets)
      await db
        .insert(blobs)
        .values({
          hash: assetsHash,
          contentType: "application/json",
          content: new TextEncoder().encode(JSON.stringify(assets)),
        })
        .onConflictDoNothing()
      const latest = await latestVersion(doc.key)
      if (!latest) {
        await db.insert(versions).values({
          id: nanoid(16),
          documentKey: doc.key,
          tag: null,
          label: head.label,
          files: sources,
          sourceHash: await sourceHash({ entry: doc.entry, files: sources, assets: assetsHash }),
          commitSha: head.sha,
          publishedAt: now(),
          assetsBlob: assetsHash,
        })
        imported.push(doc.key)
      } else if (latest.assetsBlob !== assetsHash) {
        // Fonts or the shared class changed in the repository: compile with the new ones.
        await db.update(versions).set({ assetsBlob: assetsHash }).where(eq(versions.id, latest.id))
      }
    }
    return { documents: manifest.documents.filter((d) => d.procedure).map((d) => d.key), imported }
  }

  async function versionPdf(viewer: Viewer, versionId: string): Promise<C.BinaryFile> {
    requirePermission(viewer, P.read, "Serve il permesso regulations:read.")
    const version = await versionRow(versionId)
    let content: Uint8Array | null = null
    if (version.pdfBlob) {
      const [blob] = await db.select().from(blobs).where(eq(blobs.hash, version.pdfBlob))
      content = blob?.content ?? null
    } else if (deps.compileVersion && version.assetsBlob) {
      const document = await loadDocument(version.documentKey)
      content = await deps.compileVersion({
        id: version.id,
        entry: document.entry,
        files: version.files,
        assets: version.assetsBlob,
      })
    }
    if (!content) fail("NOT_FOUND", "Il PDF di questa versione non è disponibile.")
    return {
      fileName: `${version.documentKey}-${(version.tag ?? version.label).replace(/[^\w.-]+/g, "_")}.pdf`,
      contentType: "application/pdf",
      base64: Buffer.from(content).toString("base64"),
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Drafts
  // ------------------------------------------------------------------------------------------------------------------

  async function createDraft(viewer: Viewer, input: C.CreateDraftInput): Promise<C.Draft> {
    const document = await loadDocument(input.documentKey)
    if (input.kind === "rettifica") {
      if (!(await rectifyRight(viewer, document.key)))
        fail("FORBIDDEN", "Solo il Segretario o chi ha una sua delega può avviare una rettifica.")
    } else requirePermission(viewer, P.write, "Serve il permesso regulations:write per creare bozze.")
    let baseFiles: C.Files
    let baseVersionId: string | null = null
    let baseDraftId: string | null = null
    if (input.from.kind === "version") {
      const version = await versionRow(input.from.id)
      if (version.documentKey !== document.key) fail("BAD_REQUEST", "La versione è di un altro documento.")
      baseFiles = version.files
      baseVersionId = version.id
    } else {
      const { draft: source } = await access(viewer, input.from.id)
      if (source.documentKey !== document.key) fail("BAD_REQUEST", "La bozza di origine è di un altro documento.")
      baseFiles = await currentFiles(source)
      baseDraftId = source.id
    }
    const id = nanoid(12)
    const at = now()
    await db.transaction(async (tx) => {
      await tx.insert(drafts).values({
        id,
        documentKey: document.key,
        title: input.title,
        kind: input.kind,
        state: "bozza",
        baseVersionId,
        baseDraftId,
        baseFiles,
        parses: parseDocument(baseFiles, document.entry).parses,
        createdBy: viewer.person,
        createdAt: at,
        updatedAt: at,
        stateChangedAt: at,
      })
      await tx.insert(ydocs).values({ draftId: id, state: encodeFiles(baseFiles), updatedAt: at })
      await tx.insert(assignments).values({
        draftId: id,
        userSub: viewer.sub,
        user: viewer.person,
        role: "editor",
        assignedBy: viewer.person,
        assignedAt: at,
      })
    })
    await saveSnapshot(db, { draftId: id, kind: "base", name: "Creazione", files: baseFiles, by: viewer.person })
    const draft = await loadDraft(id)
    return draftView(viewer, draft, "editor")
  }

  async function listDrafts(viewer: Viewer, input: { documentKey?: string; includeClosed: boolean }) {
    const filters = [isNull(drafts.deletedAt)]
    if (input.documentKey) filters.push(eq(drafts.documentKey, input.documentKey))
    if (!input.includeClosed) filters.push(inArray(drafts.state, ["bozza", "in_approvazione", "approvata"]))
    let rows: DraftRow[]
    if (viewer.can(P.read) || viewer.can(P.write))
      rows = await db
        .select()
        .from(drafts)
        .where(and(...filters))
    else
      rows = (
        await db
          .select({ draft: drafts })
          .from(drafts)
          .innerJoin(assignments, and(eq(assignments.draftId, drafts.id), eq(assignments.userSub, viewer.sub)))
          .where(and(...filters))
      ).map((r) => r.draft)
    rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
    const out: C.DraftSummary[] = []
    for (const draft of rows) {
      const role = await roleOf(viewer, draft)
      if (role) out.push(await summary(draft, role))
    }
    return out
  }

  async function getDraft(viewer: Viewer, draftId: string) {
    const { draft, role } = await access(viewer, draftId)
    return draftView(viewer, draft, role)
  }

  async function renameDraft(viewer: Viewer, input: { draftId: string; title: string }) {
    const { draft } = await access(viewer, input.draftId, "editor")
    if (draft.state === "emanata") fail("PRECONDITION_FAILED", "Una bozza emanata non si rinomina.")
    await db.update(drafts).set({ title: input.title, updatedAt: now() }).where(eq(drafts.id, draft.id))
  }

  async function deleteDraft(viewer: Viewer, draftId: string) {
    const { draft, role } = await access(viewer, draftId)
    const view = await draftView(viewer, draft, role)
    if (!view.can.delete) fail("FORBIDDEN", "Questa bozza non può essere eliminata.")
    await db.update(drafts).set({ deletedAt: now(), deletedBy: viewer.person }).where(eq(drafts.id, draft.id))
  }

  async function draftFiles(viewer: Viewer, draftId: string) {
    const { draft } = await access(viewer, draftId)
    const document = await loadDocument(draft.documentKey)
    const files = await currentFiles(draft)
    return { files, structure: structureOf(files, document.entry) }
  }

  async function transition(viewer: Viewer, input: C.TransitionInput) {
    const { draft, role } = await access(viewer, input.draftId)
    const document = await loadDocument(draft.documentKey)
    const rule = procedureOf(document.procedure).transitions.find(
      (r) => r.from === draft.state && r.to === input.to && r.kinds.includes(draft.kind)
    )
    if (!rule) fail("BAD_REQUEST", "Passaggio di stato non previsto dalla procedura.")
    if (rule.effect === "emanate") fail("BAD_REQUEST", "Per emanare usa «Emana e notifica».")
    const rectify = (await rectifyRight(viewer, draft.documentKey)) !== null
    if (!allowed(viewer, rule.who, rectify)) fail("FORBIDDEN", "Non hai il permesso per questo passaggio di stato.")
    if (await emanationOf(draft.id)) fail("PRECONDITION_FAILED", "L'emanazione è in corso.")
    const at = now()
    const stateLabel = procedureOf(document.procedure).states.find((s) => s.key === rule.to)?.label ?? rule.to

    if (rule.effect === "freeze") {
      const other = await inApproval(draft.documentKey, draft.id)
      if (other) fail("CONFLICT", `C'è già una bozza in approvazione per questo documento: «${other.title}».`)
      const superseded = await supersededReason(draft)
      if (superseded) fail("PRECONDITION_FAILED", superseded)
      let files: C.Files
      let parses: boolean
      if (deps.collab) ({ files, parses } = await deps.collab.freeze(draft.id))
      else {
        files = await currentFiles(draft)
        parses = parseDocument(files, document.entry).parses
      }
      if (!parses) {
        await deps.collab?.reopen(draft.id)
        fail("PRECONDITION_FAILED", "Il testo non è valido: correggi gli errori prima di inviarlo in approvazione.")
      }
      try {
        await db
          .update(drafts)
          .set({ state: rule.to, frozenFiles: files, parses, stateChangedAt: at, updatedAt: at })
          .where(and(eq(drafts.id, draft.id), eq(drafts.state, draft.state)))
      } catch (error) {
        await deps.collab?.reopen(draft.id)
        if (String((error as { code?: string }).code ?? error).includes("23505"))
          fail("CONFLICT", "C'è già una bozza in approvazione per questo documento.")
        throw error
      }
      await saveSnapshot(db, { draftId: draft.id, kind: "state", name: stateLabel, files, by: viewer.person })
      await deps.hooks?.sentToApproval?.(draft.id, viewer.person)
    } else if (rule.effect === "reopen") {
      await db
        .update(drafts)
        .set({ state: rule.to, frozenFiles: null, stateChangedAt: at, updatedAt: at })
        .where(eq(drafts.id, draft.id))
      await deps.collab?.reopen(draft.id)
      await saveSnapshot(db, {
        draftId: draft.id,
        kind: "state",
        name: stateLabel,
        files: await currentFiles({ ...draft, frozenFiles: null }),
        by: viewer.person,
      })
    } else if (rule.effect === "approve") {
      if (!input.delibera) fail("BAD_REQUEST", "Indica l'organo, la data della delibera e, se c'è, il verbale.")
      if (input.delibera.date > new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome" }).format(at))
        fail("BAD_REQUEST", "La data della delibera non può essere nel futuro.")
      await db.transaction(async (tx) => {
        await tx
          .insert(delibere)
          .values({
            draftId: draft.id,
            kind: "approvazione",
            body: input.delibera?.body,
            date: input.delibera?.date as string,
            verbaleUrl: input.delibera?.verbaleUrl ?? null,
            recordedBy: viewer.person,
            recordedAt: at,
          })
          .onConflictDoUpdate({
            target: delibere.draftId,
            set: {
              body: input.delibera?.body,
              date: input.delibera?.date,
              verbaleUrl: input.delibera?.verbaleUrl ?? null,
              recordedBy: viewer.person,
              recordedAt: at,
            },
          })
        await tx
          .update(drafts)
          .set({ state: rule.to, approvedAt: at, stateChangedAt: at, updatedAt: at })
          .where(eq(drafts.id, draft.id))
      })
      await saveSnapshot(db, {
        draftId: draft.id,
        kind: "state",
        name: stateLabel,
        files: draft.frozenFiles ?? (await currentFiles(draft)),
        by: viewer.person,
      })
    }
    await deps.collab?.broadcast(draft.id, { type: "state", state: rule.to }).catch(() => {})
    return draftView(viewer, await loadDraft(draft.id), role)
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Assignments, tickets, compile
  // ------------------------------------------------------------------------------------------------------------------

  async function listAssignments(viewer: Viewer, draftId: string): Promise<C.Assignment[]> {
    await access(viewer, draftId)
    const rows = await db
      .select()
      .from(assignments)
      .where(eq(assignments.draftId, draftId))
      .orderBy(asc(assignments.assignedAt))
    return rows.map((r) => ({
      user: r.user,
      role: r.role,
      assignedBy: r.assignedBy,
      assignedAt: r.assignedAt.toISOString(),
    }))
  }

  async function setAssignment(viewer: Viewer, input: { draftId: string; userId: string; role: C.DraftRole }) {
    requirePermission(viewer, P.write, "Solo il Direttivo assegna le persone alle bozze.")
    const draft = await loadDraft(input.draftId)
    if (draft.state === "emanata") fail("PRECONDITION_FAILED", "La bozza è già emanata.")
    const user = await directory.find(input.userId)
    if (!user) fail("NOT_FOUND", "Account non trovato tra quelli di PoliNetwork.")
    const values = { user, role: input.role, assignedBy: viewer.person, assignedAt: now() }
    await db
      .insert(assignments)
      .values({ draftId: draft.id, userSub: user.id, ...values })
      .onConflictDoUpdate({ target: [assignments.draftId, assignments.userSub], set: values })
  }

  async function removeAssignment(viewer: Viewer, input: { draftId: string; userId: string }) {
    requirePermission(viewer, P.write, "Solo il Direttivo assegna le persone alle bozze.")
    await loadDraft(input.draftId)
    await db
      .delete(assignments)
      .where(and(eq(assignments.draftId, input.draftId), eq(assignments.userSub, input.userId)))
  }

  async function collabTicket(viewer: Viewer, draftId: string): Promise<C.CollabTicket> {
    const { draft, role } = await access(viewer, draftId)
    if (!deps.collabUrl) fail("PRECONDITION_FAILED", "Il servizio di collaborazione non è configurato.")
    const readOnly = role !== "editor" || !isEditable(draft) || (await emanationOf(draft.id)) !== null
    const { ticket, expiresAt } = await issueTicket(db, { draftId: draft.id, user: viewer.person, role, readOnly })
    return { url: deps.collabUrl, documentName: draft.id, ticket, role, readOnly, expiresAt: expiresAt.toISOString() }
  }

  async function compileStatus(viewer: Viewer, draftId: string) {
    await access(viewer, draftId)
    return readCompileStatus(db, draftId)
  }

  async function compilePdf(viewer: Viewer, input: { draftId: string; hash: string }): Promise<C.BinaryFile> {
    const { draft } = await access(viewer, input.draftId)
    const content = await readCompilePdf(db, draft.id, input.hash)
    if (!content) fail("NOT_FOUND", "PDF non disponibile per questa versione del testo.")
    return {
      fileName: `${draft.documentKey}-${draft.id}.pdf`,
      contentType: "application/pdf",
      base64: Buffer.from(content).toString("base64"),
    }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Snapshots
  // ------------------------------------------------------------------------------------------------------------------

  const snapshotView = (s: typeof snapshots.$inferSelect): C.Snapshot => ({
    id: s.id,
    draftId: s.draftId,
    kind: s.kind,
    name: s.name,
    createdAt: s.createdAt.toISOString(),
    createdBy: s.createdBy,
  })

  async function listSnapshots(viewer: Viewer, draftId: string) {
    await access(viewer, draftId)
    const rows = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.draftId, draftId))
      .orderBy(desc(snapshots.createdAt))
    return rows.map(snapshotView)
  }

  async function snapshotRow(viewer: Viewer, snapshotId: string, min: C.DraftRole = "viewer") {
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, snapshotId))
    if (!row) fail("NOT_FOUND", "Versione della cronologia non trovata.")
    const { draft } = await access(viewer, row.draftId, min)
    return { row, draft }
  }

  async function getSnapshot(viewer: Viewer, snapshotId: string) {
    const { row } = await snapshotRow(viewer, snapshotId)
    return { ...snapshotView(row), files: row.files }
  }

  async function createSnapshot(viewer: Viewer, input: { draftId: string; name: string }) {
    const { draft } = await access(viewer, input.draftId, "editor")
    const id = await saveSnapshot(db, {
      draftId: draft.id,
      kind: "named",
      name: input.name,
      files: await currentFiles(draft),
      by: viewer.person,
    })
    const [row] = await db.select().from(snapshots).where(eq(snapshots.id, id))
    return snapshotView(row)
  }

  /** Never destructive: the current text is kept as a snapshot, then the old one comes back as a new edit. */
  async function restoreSnapshot(viewer: Viewer, snapshotId: string) {
    const { row, draft } = await snapshotRow(viewer, snapshotId, "editor")
    if (!isEditable(draft) || (await emanationOf(draft.id)))
      fail("PRECONDITION_FAILED", "La bozza non è modificabile in questo stato.")
    if (!deps.collab) fail("PRECONDITION_FAILED", "Il servizio di collaborazione non è configurato.")
    const label =
      row.name ??
      new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short", timeZone: "Europe/Rome" }).format(
        row.createdAt
      )
    await saveSnapshot(db, {
      draftId: draft.id,
      kind: "restore",
      name: `Prima del ripristino di «${label}»`,
      files: await currentFiles(draft),
      by: viewer.person,
    })
    const files = await deps.collab.replace(draft.id, row.files)
    const id = await saveSnapshot(db, {
      draftId: draft.id,
      kind: "restore",
      name: `Ripristino di «${label}»`,
      files,
      by: viewer.person,
    })
    const [restored] = await db.select().from(snapshots).where(eq(snapshots.id, id))
    return snapshotView(restored)
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Comments
  // ------------------------------------------------------------------------------------------------------------------

  async function listComments(viewer: Viewer, draftId: string): Promise<C.CommentThread[]> {
    await access(viewer, draftId)
    const rows = await db.select().from(comments).where(eq(comments.draftId, draftId)).orderBy(asc(comments.createdAt))
    const view = (c: typeof comments.$inferSelect) => ({
      id: c.id,
      body: c.deletedAt ? "" : c.body,
      author: c.author,
      createdAt: c.createdAt.toISOString(),
      editedAt: iso(c.editedAt),
      deleted: c.deletedAt !== null,
    })
    return rows
      .filter((c) => c.parentId === null)
      .map((root) => ({
        ...view(root),
        draftId,
        anchor: { file: root.file as string, start: root.anchorStart as string, end: root.anchorEnd as string },
        quote: root.quote ?? "",
        resolvedAt: iso(root.resolvedAt),
        resolvedBy: root.resolvedBy,
        replies: rows.filter((c) => c.parentId === root.id).map(view),
      }))
  }

  async function commentable(viewer: Viewer, draftId: string) {
    const { draft } = await access(viewer, draftId, "commenter")
    if (draft.state === "emanata") fail("PRECONDITION_FAILED", "Una bozza emanata non si commenta.")
    return draft
  }

  async function createComment(viewer: Viewer, input: C.CreateCommentInput) {
    const draft = await commentable(viewer, input.draftId)
    const id = nanoid(16)
    await db.insert(comments).values({
      id,
      draftId: draft.id,
      parentId: null,
      file: input.anchor.file,
      anchorStart: input.anchor.start,
      anchorEnd: input.anchor.end,
      quote: input.quote,
      body: input.body,
      author: viewer.person,
      createdAt: now(),
    })
    return { id }
  }

  async function commentRow(commentId: string) {
    const [row] = await db.select().from(comments).where(eq(comments.id, commentId))
    if (!row) fail("NOT_FOUND", "Commento non trovato.")
    return row
  }

  async function replyComment(viewer: Viewer, input: { commentId: string; body: string }) {
    const parent = await commentRow(input.commentId)
    const draft = await commentable(viewer, parent.draftId)
    const id = nanoid(16)
    await db.insert(comments).values({
      id,
      draftId: draft.id,
      parentId: parent.parentId ?? parent.id,
      body: input.body,
      author: viewer.person,
      createdAt: now(),
    })
    return { id }
  }

  async function setResolved(viewer: Viewer, commentId: string, resolved: boolean) {
    const row = await commentRow(commentId)
    if (row.parentId) fail("BAD_REQUEST", "Si risolve una discussione, non una risposta.")
    await commentable(viewer, row.draftId)
    await db
      .update(comments)
      .set(resolved ? { resolvedAt: now(), resolvedBy: viewer.person } : { resolvedAt: null, resolvedBy: null })
      .where(eq(comments.id, commentId))
  }

  async function deleteComment(viewer: Viewer, commentId: string) {
    const row = await commentRow(commentId)
    await access(viewer, row.draftId, "commenter")
    if (row.author.id !== viewer.sub && !viewer.can(P.write)) fail("FORBIDDEN", "Puoi eliminare solo i tuoi commenti.")
    await db.update(comments).set({ deletedAt: now() }).where(eq(comments.id, commentId))
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Merge
  // ------------------------------------------------------------------------------------------------------------------

  const formatDate = (d: Date) =>
    new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeZone: "Europe/Rome" }).format(d)

  /** The common ancestor: the source's text at the last merge, a fork point, or the shared published version. */
  async function mergeBase(target: DraftRow, source: C.MergeSource): Promise<{ files: C.Files; label: string }> {
    const [last] = await db
      .select()
      .from(merges)
      .where(
        and(eq(merges.targetDraftId, target.id), eq(merges.sourceKind, source.kind), eq(merges.sourceId, source.id))
      )
      .orderBy(desc(merges.mergedAt))
      .limit(1)
    if (last) return { files: last.sourceFiles, label: `ultimo merge del ${formatDate(last.mergedAt)}` }
    if (source.kind === "draft") {
      const other = await loadDraft(source.id)
      if (other.baseDraftId === target.id) return { files: other.baseFiles, label: `creazione di «${other.title}»` }
      if (target.baseDraftId === other.id) return { files: target.baseFiles, label: `creazione di «${target.title}»` }
      const theirRoot = await rootVersion(other)
      const ourRoot = await rootVersion(target)
      if (theirRoot.id === ourRoot.id) return { files: ourRoot.files, label: ourRoot.label }
    }
    const root = await rootVersion(target)
    return { files: root.files, label: root.label }
  }

  async function mergeInputs(viewer: Viewer, input: { targetDraftId: string; source: C.MergeSource }) {
    requirePermission(viewer, P.write, "Serve il permesso regulations:write per unire le bozze.")
    const { draft: target } = await access(viewer, input.targetDraftId, "editor")
    const document = await loadDocument(target.documentKey)
    let theirs: C.Files
    if (input.source.kind === "draft") {
      if (input.source.id === target.id) fail("BAD_REQUEST", "Non si unisce una bozza con sé stessa.")
      const { draft: source } = await access(viewer, input.source.id)
      if (source.documentKey !== target.documentKey) fail("BAD_REQUEST", "La bozza è di un altro documento.")
      theirs = await currentFiles(source)
    } else {
      const version = await versionRow(input.source.id)
      if (version.documentKey !== target.documentKey) fail("BAD_REQUEST", "La versione è di un altro documento.")
      theirs = version.files
    }
    const base = await mergeBase(target, input.source)
    const ours = await currentFiles(target)
    const editable = isEditable(target) && !(await emanationOf(target.id))
    return { target, document, base, ours, theirs, editable }
  }

  async function previewMerge(
    viewer: Viewer,
    input: { targetDraftId: string; source: C.MergeSource }
  ): Promise<C.MergePreview> {
    const { document, base, ours, theirs, editable } = await mergeInputs(viewer, input)
    const result = merge3({ base: base.files, ours, theirs, entry: document.entry })
    return {
      blockedBy: editable ? result.blockedBy : "La bozza di destinazione non è modificabile in questo stato.",
      baseLabel: base.label,
      conflicts: result.conflicts,
      applied: result.applied,
      warnings: result.warnings,
    }
  }

  async function applyMerge(viewer: Viewer, input: C.ApplyMergeInput) {
    const { target, document, base, ours, theirs, editable } = await mergeInputs(viewer, input)
    if (!editable) fail("PRECONDITION_FAILED", "La bozza di destinazione non è modificabile in questo stato.")
    if (!deps.collab) fail("PRECONDITION_FAILED", "Il servizio di collaborazione non è configurato.")
    const result = merge3({ base: base.files, ours, theirs, entry: document.entry }, input.resolutions)
    if (result.blockedBy) fail("PRECONDITION_FAILED", result.blockedBy)
    if (result.unresolved.length)
      fail("PRECONDITION_FAILED", `Ci sono ancora ${result.unresolved.length} conflitti da risolvere.`)
    if (!parseDocument(result.files, document.entry).parses)
      fail("PRECONDITION_FAILED", "Il testo risultante non è valido: controlla le risoluzioni scritte a mano.")
    await saveSnapshot(db, {
      draftId: target.id,
      kind: "merge",
      name: "Prima del merge",
      files: ours,
      by: viewer.person,
    })
    const files = await deps.collab.replace(target.id, result.files)
    await db.insert(merges).values({
      id: nanoid(16),
      targetDraftId: target.id,
      sourceKind: input.source.kind,
      sourceId: input.source.id,
      sourceFiles: theirs,
      resolutions: input.resolutions,
      mergedBy: viewer.person,
      mergedAt: now(),
    })
    const snapshotId = await saveSnapshot(db, {
      draftId: target.id,
      kind: "merge",
      name: "Merge",
      files,
      by: viewer.person,
    })
    return { snapshotId }
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Deleghe
  // ------------------------------------------------------------------------------------------------------------------

  const delegaView = (d: typeof deleghe.$inferSelect): C.Delega => ({
    id: d.id,
    grantee: d.grantee,
    documentKey: d.documentKey,
    expiresAt: iso(d.expiresAt),
    note: d.note,
    grantedBy: d.grantedBy,
    createdAt: d.createdAt.toISOString(),
    revokedAt: iso(d.revokedAt),
    revokedBy: d.revokedBy,
    active: !d.revokedAt && (!d.expiresAt || d.expiresAt > now()),
  })

  async function listDeleghe(viewer: Viewer) {
    const rows = viewer.can(P.rectify)
      ? await db.select().from(deleghe).orderBy(desc(deleghe.createdAt))
      : await db.select().from(deleghe).where(eq(deleghe.granteeSub, viewer.sub)).orderBy(desc(deleghe.createdAt))
    return rows.map(delegaView)
  }

  async function createDelega(viewer: Viewer, input: C.CreateDelegaInput) {
    requirePermission(viewer, P.rectify, "Solo il Segretario può delegare la rettifica.")
    if (input.userId === viewer.sub) fail("BAD_REQUEST", "Non puoi delegare te stesso.")
    const grantee = await directory.find(input.userId)
    if (!grantee) fail("NOT_FOUND", "Account non trovato tra quelli di PoliNetwork.")
    if (input.documentKey) await loadDocument(input.documentKey)
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null
    if (expiresAt && expiresAt <= now()) fail("BAD_REQUEST", "La scadenza deve essere nel futuro.")
    const id = nanoid(16)
    await db.insert(deleghe).values({
      id,
      granteeSub: grantee.id,
      grantee,
      documentKey: input.documentKey ?? null,
      expiresAt,
      note: input.note ?? null,
      grantedBy: viewer.person,
      createdAt: now(),
    })
    await deps.hooks?.delegaChanged?.(id, "created")
    const [row] = await db.select().from(deleghe).where(eq(deleghe.id, id))
    return delegaView(row)
  }

  async function revokeDelega(viewer: Viewer, delegaId: string) {
    requirePermission(viewer, P.rectify, "Solo il Segretario può revocare una delega.")
    const [row] = await db.select().from(deleghe).where(eq(deleghe.id, delegaId))
    if (!row) fail("NOT_FOUND", "Delega non trovata.")
    if (row.revokedAt) fail("PRECONDITION_FAILED", "La delega è già revocata.")
    await db.update(deleghe).set({ revokedAt: now(), revokedBy: viewer.person }).where(eq(deleghe.id, delegaId))
    await deps.hooks?.delegaChanged?.(delegaId, "revoked")
  }

  return {
    me,
    searchUsers: async (viewer: Viewer, q: string): Promise<C.UserMatch[]> => {
      if (!viewer.can(P.write) && !viewer.can(P.rectify)) fail("FORBIDDEN", "Serve il permesso regulations:write.")
      if (!directory.configured) fail("PRECONDITION_FAILED", "La rubrica degli account non è configurata.")
      return directory.search(q)
    },
    listDocuments: async (viewer: Viewer) => {
      requirePermission(viewer, P.read, "Serve il permesso regulations:read.")
      const rows = await db.select().from(documents).orderBy(asc(documents.key))
      return Promise.all(rows.map(documentView))
    },
    getDocument: async (viewer: Viewer, key: string) => {
      requirePermission(viewer, P.read, "Serve il permesso regulations:read.")
      return documentView(await loadDocument(key))
    },
    syncDocuments,
    listVersions: async (viewer: Viewer, documentKey: string) => {
      requirePermission(viewer, P.read, "Serve il permesso regulations:read.")
      const rows = await db
        .select()
        .from(versions)
        .where(eq(versions.documentKey, documentKey))
        .orderBy(desc(versions.publishedAt))
      return Promise.all(rows.map(versionSummary))
    },
    versionPdf,
    createDraft,
    listDrafts,
    getDraft,
    renameDraft,
    deleteDraft,
    draftFiles,
    transition,
    listAssignments,
    setAssignment,
    removeAssignment,
    collabTicket,
    compileStatus,
    compilePdf,
    listSnapshots,
    getSnapshot,
    createSnapshot,
    restoreSnapshot,
    listComments,
    createComment,
    replyComment,
    resolveComment: (viewer: Viewer, id: string) => setResolved(viewer, id, true),
    reopenComment: (viewer: Viewer, id: string) => setResolved(viewer, id, false),
    deleteComment,
    previewMerge,
    applyMerge,
    listDeleghe,
    createDelega,
    revokeDelega,
    // For the procedure modules (diff, emanation).
    internal: {
      access,
      loadDraft,
      loadDocument,
      currentFiles,
      rootVersion,
      rectifyRight,
      draftView,
      emanationOf,
      supersededReason,
    },
  }
}

export type RegulationsService = ReturnType<typeof createRegulationsService>
