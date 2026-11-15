import { desc, eq } from "drizzle-orm"
import { nanoid } from "nanoid"
import { blobs, diffs, documents, versions } from "@/db/schema/regulations"
import type { AssetBundle } from "../compile/protocol"
import type * as C from "../contract"
import { REGULATION_PERMISSIONS as P } from "../contract"
import { type RegulationsDb, sha256 } from "../db"
import { diffDocuments } from "../latex"
import { fail, type RegulationsService, type Viewer } from "../service"
import { renderDifferencesPdf } from "./pdf"
import { type DiffSummarizer, normalizeCategories } from "./summarizer"

/**
 * The smart diff (spec decision 9): the structural diff between the version in force and the draft's frozen text,
 * grouped by theme by an LLM, plus the differences PDF. Generated when a draft is sent to approval (or a rettifica is
 * emanated); not editable; `regulations:manage` may regenerate it until the notification goes out.
 */
export function createDiffService(deps: {
  db: RegulationsDb
  regulations: RegulationsService
  summarizer: DiffSummarizer | null
  onError?: (error: unknown, draftId: string) => void
  now?: () => Date
}) {
  const { db } = deps
  const now = deps.now ?? (() => new Date())
  const { loadDraft, loadDocument, currentFiles, access, emanationOf } = deps.regulations.internal
  const running = new Map<string, Promise<void>>()

  async function latestRow(draftId: string) {
    const [row] = await db
      .select()
      .from(diffs)
      .where(eq(diffs.draftId, draftId))
      .orderBy(desc(diffs.generation))
      .limit(1)
    return row ?? null
  }

  /** The version in force: what the draft will replace. */
  async function versionInForce(documentKey: string, excludeDraft: string) {
    const rows = await db
      .select()
      .from(versions)
      .where(eq(versions.documentKey, documentKey))
      .orderBy(desc(versions.publishedAt))
    return rows.find((v) => v.draftId !== excludeDraft) ?? null
  }

  async function fontsOf(assetsHash: string | null) {
    if (!assetsHash) return null
    const [blob] = await db.select().from(blobs).where(eq(blobs.hash, assetsHash))
    if (!blob) return null
    const bundle = JSON.parse(Buffer.from(blob.content).toString("utf8")) as AssetBundle
    const find = (suffix: string) => Object.entries(bundle.files).find(([path]) => path.endsWith(suffix))?.[1]
    const regular = find("Ubuntu-Regular.ttf")
    const bold = find("Ubuntu-Bold.ttf")
    return regular && bold
      ? { regular: new Uint8Array(Buffer.from(regular, "base64")), bold: new Uint8Array(Buffer.from(bold, "base64")) }
      : null
  }

  async function locked(draft: Awaited<ReturnType<typeof loadDraft>>) {
    if (draft.notifiedAt) return true
    const emanation = await emanationOf(draft.id)
    return emanation?.steps.email.state === "done"
  }

  /** Renders the differences PDF from a stored generation (the final one carries the tag and the delibera). */
  async function renderPdf(draftId: string, labels: { newLabel?: string; subtitle?: string | null } = {}) {
    const row = await latestRow(draftId)
    if (!row || row.status !== "ready") throw new Error("diff not ready")
    const draft = await loadDraft(draftId)
    const [document] = await db.select().from(documents).where(eq(documents.key, draft.documentKey))
    const base = await versionInForce(draft.documentKey, draft.id)
    const content = await renderDifferencesPdf({
      documentTitle: document.title,
      baseLabel: row.baseLabel,
      newLabel: labels.newLabel ?? `bozza «${draft.title}»`,
      subtitle: labels.subtitle ?? (draft.state === "in_approvazione" ? "Testo inviato in approvazione" : null),
      categories: row.categories ?? [],
      articles: row.articles,
      otherChanges: row.otherChanges,
      generatedAt: row.finishedAt ?? now(),
      fonts: await fontsOf(base?.assetsBlob ?? null),
    })
    const hash = sha256(content)
    await db.insert(blobs).values({ hash, contentType: "application/pdf", content }).onConflictDoNothing()
    await db.update(diffs).set({ pdfBlob: hash }).where(eq(diffs.id, row.id))
    return content
  }

  async function run(rowId: string, draftId: string) {
    try {
      const [row] = await db.select().from(diffs).where(eq(diffs.id, rowId))
      const draft = await loadDraft(draftId)
      const document = await loadDocument(draft.documentKey)
      if (!deps.summarizer) throw new Error("Nessun modello configurato per il riassunto (REGULATIONS_LLM_PROVIDER).")
      const categories = normalizeCategories(
        await deps.summarizer.summarize({
          documentTitle: document.title,
          baseLabel: row.baseLabel,
          articles: row.articles,
          otherChanges: row.otherChanges,
        }),
        row.articles
      )
      await db
        .update(diffs)
        .set({ status: "ready", categories, finishedAt: now(), error: null })
        .where(eq(diffs.id, rowId))
      await renderPdf(draftId)
    } catch (error) {
      deps.onError?.(error, draftId)
      await db
        .update(diffs)
        .set({ status: "failed", error: error instanceof Error ? error.message : String(error), finishedAt: now() })
        .where(eq(diffs.id, rowId))
    }
  }

  /** Starts a new generation: the structural diff now, categories and PDF in the background. */
  async function generate(draftId: string, by: C.PersonRef | null) {
    const draft = await loadDraft(draftId)
    const document = await loadDocument(draft.documentKey)
    const base = await versionInForce(draft.documentKey, draft.id)
    if (!base) fail("PRECONDITION_FAILED", "Non c'è una versione pubblicata con cui confrontare.")
    const files = await currentFiles(draft)
    const structural = diffDocuments(base.files, files, document.entry)
    const previous = await latestRow(draftId)
    const id = nanoid(16)
    await db.insert(diffs).values({
      id,
      draftId,
      generation: (previous?.generation ?? 0) + 1,
      status: "pending",
      baseLabel: base.tag ?? base.label,
      articles: structural.articles,
      otherChanges: structural.otherChanges,
      provider: deps.summarizer?.provider ?? null,
      model: deps.summarizer?.model ?? null,
      requestedBy: by,
      createdAt: now(),
    })
    const job = run(id, draftId).finally(() => running.delete(draftId))
    running.set(draftId, job)
    return { id, job }
  }

  async function get(viewer: Viewer, draftId: string): Promise<C.Diff> {
    const { draft } = await access(viewer, draftId)
    const row = await latestRow(draftId)
    const isLocked = await locked(draft)
    if (!row)
      return {
        status: "none",
        generation: 0,
        generatedAt: null,
        generatedBy: null,
        provider: null,
        model: null,
        error: null,
        baseLabel: "",
        categories: [],
        articles: [],
        otherChanges: [],
        locked: isLocked,
      }
    return {
      status: row.status,
      generation: row.generation,
      generatedAt: row.finishedAt?.toISOString() ?? null,
      generatedBy: row.requestedBy,
      provider: row.provider,
      model: row.model,
      error: row.error,
      baseLabel: row.baseLabel,
      categories: row.categories ?? [],
      articles: row.articles,
      otherChanges: row.otherChanges,
      locked: isLocked,
    }
  }

  async function regenerate(viewer: Viewer, draftId: string) {
    if (!viewer.can(P.manage)) fail("FORBIDDEN", "Solo Presidente e Segretario possono rigenerare le differenze.")
    const { draft } = await access(viewer, draftId)
    if (
      draft.state !== "in_approvazione" &&
      draft.state !== "approvata" &&
      !(draft.kind === "rettifica" && draft.frozenFiles)
    )
      fail("PRECONDITION_FAILED", "Le differenze si generano quando la bozza è in approvazione.")
    if (await locked(draft))
      fail("PRECONDITION_FAILED", "Le differenze sono già state notificate: non si rigenerano più.")
    const row = await latestRow(draftId)
    if (row?.status === "pending" || running.has(draftId)) fail("CONFLICT", "Le differenze sono già in generazione.")
    await generate(draftId, viewer.person)
    return get(viewer, draftId)
  }

  async function pdf(viewer: Viewer, draftId: string): Promise<C.BinaryFile> {
    const { draft } = await access(viewer, draftId)
    const row = await latestRow(draftId)
    if (!row || row.status !== "ready") fail("NOT_FOUND", "Le differenze non sono ancora pronte.")
    let content: Uint8Array | null = null
    if (row.pdfBlob) {
      const [blob] = await db.select().from(blobs).where(eq(blobs.hash, row.pdfBlob))
      content = blob?.content ?? null
    }
    content ??= await renderPdf(draftId)
    return {
      fileName: `differenze-${draft.documentKey}-${draft.id}.pdf`,
      contentType: "application/pdf",
      base64: Buffer.from(content).toString("base64"),
    }
  }

  return {
    generate,
    get,
    regenerate,
    pdf,
    renderPdf,
    latestRow,
    /** Waits for a running generation (tests, emanation). */
    settled: (draftId: string) => running.get(draftId) ?? Promise.resolve(),
  }
}

export type DiffService = ReturnType<typeof createDiffService>
