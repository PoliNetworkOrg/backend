import { and, asc, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  blobs,
  type DocumentCreationJson,
  deleghe,
  delibere,
  documents,
  drafts,
  type EmanationStepJson,
  type EmanationStepKey,
  emanations,
  notifications,
  versions,
} from "@/db/schema/regulations"
import { attachedLine } from "@/emails/templates/regulation-emanated"
import type { CollabControl } from "../collab/internal-client"
import { saveSnapshot } from "../collab/persistence"
import type { AssetBundle } from "../compile/protocol"
import { sourceHash } from "../compile/protocol"
import type * as C from "../contract"
import { EMANATION_STEPS } from "../contract"
import { type RegulationsDb, sha256 } from "../db"
import type { DiffService } from "../diff/service"
import type { Directory } from "../directory"
import { applyDelibera, DeliberaMacroMissing, parseDocument } from "../latex"
import { appendDocumentEntry, githubLegalSource, MANIFEST_PATH, parseManifest } from "../legal-source"
import { deadlineAt, emanateRule, todayInItaly } from "../procedure"
import { fail, type RegulationsService, type Viewer } from "../service"
import { strayFiles, strayFilesMessage } from "../sources"
import type { LegalGitHub } from "./github"
import { sendOnce, telegramEscape } from "./notify"

export type EmanationNotifier = {
  email(input: {
    to: string
    /** Empty for none. */
    cc: string[]
    from?: string
    replyTo?: { name: string; address: string }
    messageId: string
    props: {
      documentTitle: string
      deliberaLine: string
      tag: string
      attached: { official: string | null; differences: string | null }
      dashboardUrl: string | null
      categories: { title: string; summary: string }[]
      oppositionDeadline: string | null
    }
    attachments: { filename: string; content: Uint8Array; contentType: string }[]
  }): Promise<void>
  delegaEmail(input: {
    to: string
    from?: string
    messageId: string
    props: {
      change: "created" | "revoked" | "used"
      grantor: string
      grantee: string
      scope: string | null
      expiresOn: string | null
      note: string | null
      actor: string
      rettifica?: { documentTitle: string; tag: string; dashboardUrl: string | null } | null
    }
  }): Promise<void>
  telegram(payload: {
    chatId: number
    topicId: number | null
    /** The notification's id: the same on every retry, so the bot can post once. */
    idempotencyKey: string
    text: string
    regulation: {
      documentTitle: string
      draftTitle: string
      body: string
      deliberaDate: string
      oppositionDeadline: string | null
      tag: string
      dashboardUrl: string | null
    }
    files: { filename: string; contentType: string; base64: string }[]
  }): Promise<{ messageIds: number[] }>
}

export type EmanationConfig = {
  baseBranch: string
  /** soci@polinetwork.org */
  emailTo: string
  /** In CC on the Soci's notice (direttivo@, probiviri@); not on the deleghe emails. */
  emailCc?: string[]
  /** The sender mailbox, when not the default one (still to be decided). */
  emailFrom?: string
  /** direttivo@polinetwork.org */
  replyTo: string
  /** direttivo@polinetwork.org, for deleghe. */
  direttivoEmail: string
  telegram: { chatId: number; topicId: number | null } | null
  /** The dashboard's view of a draft's changes, for the email. */
  webUrl: (draftId: string, documentKey: string) => string | null
  /** Seconds between checks while waiting on GitHub. */
  pollSeconds?: number
}

const BODY_LABEL: Record<C.DeliberaBody, string> = {
  consiglio_direttivo: "Consiglio Direttivo",
  assemblea: "Assemblea dei Soci",
}
const italianDate = (iso: string) => iso.split("-").reverse().join("/")
/** Bun's driver returns `date` columns as a Date at UTC midnight, whatever the column's mode. */
const dateOf = (d: { date: string | Date }) =>
  (d.date as unknown) instanceof Date
    ? (d.date as unknown as Date).toISOString().slice(0, 10)
    : String(d.date).slice(0, 10)
/** How long a creation may go without a pull request before it counts as failed (the process stopped meanwhile). */
export const CREATION_GRACE_MS = 5 * 60_000
const pending = (): EmanationStepJson => ({ state: "pending", url: null, at: null, detail: null })

/**
 * "Emana e notifica" (spec decision 10.4): a PR with the generated sources on the documents repository, auto-merged
 * once CI passes; after the merge the tag, then the release the repository's CI builds, with the differences PDF
 * attached; then the email to the Soci and the Telegram post, each recorded. Every step is idempotent and the whole
 * thing resumes from where it stopped (GitHub webhook, a 30-second poll, or `emanation.retry`).
 *
 * "Pubblica" (procedure `documento`) is the same path without delibera, differences and notices for a repository
 * document, and a publication in the database for a private one, which never reaches GitHub, the LLM, email or
 * Telegram. The same GitHub side also creates new repository documents (`createDocument`): a pull request adding the
 * document from its template, auto-merged after CI.
 */
export function createEmanationService(deps: {
  db: RegulationsDb
  regulations: RegulationsService
  diff: DiffService
  github: LegalGitHub | null
  collab: CollabControl | null
  directory: Directory
  notifier: EmanationNotifier
  config: EmanationConfig
  onError?: (error: unknown, draftId: string) => void
  now?: () => Date
}) {
  const { db, config } = deps
  const now = deps.now ?? (() => new Date())
  const { access, loadDraft, loadDocument, currentFiles, rectifyRight, emanationOf, supersededReason, procedureFor } =
    deps.regulations.internal
  const inFlight = new Map<string, Promise<void>>()

  async function deliberaOf(draftId: string) {
    // The current one: a withdrawn approval no longer counts.
    const [row] = await db
      .select()
      .from(delibere)
      .where(and(eq(delibere.draftId, draftId), isNull(delibere.withdrawnAt)))
    return row ?? null
  }

  function deliberaLine(d: typeof delibere.$inferSelect) {
    const date = italianDate(dateOf(d))
    if (d.kind === "approvazione")
      return `Approvato ${d.body === "assemblea" ? "dall'Assemblea dei Soci" : "dal Consiglio Direttivo"} il ${date}`
    return d.onBehalfOf
      ? `Rettificato da ${d.recordedBy.name} su delega del Segretario il ${date}`
      : `Rettificato dal Segretario il ${date}`
  }

  function bodyLabel(d: typeof delibere.$inferSelect) {
    if (d.kind === "approvazione") return BODY_LABEL[d.body as C.DeliberaBody]
    return d.onBehalfOf ? `Rettifica di ${d.recordedBy.name} su delega del Segretario` : "Rettifica del Segretario"
  }

  async function setStep(
    draftId: string,
    key: EmanationStepKey,
    patch: Partial<EmanationStepJson>,
    extra: Partial<typeof emanations.$inferInsert> = {}
  ) {
    const row = await emanationOf(draftId)
    if (!row) return
    const steps = { ...row.steps, [key]: { ...row.steps[key], ...patch } }
    await db
      .update(emanations)
      .set({ steps, ...extra })
      .where(eq(emanations.draftId, draftId))
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Start
  // ------------------------------------------------------------------------------------------------------------------

  /** Freezes the live text for an emanation that skips the procedure's earlier states (rettifica, documento). */
  async function freeze(draft: { id: string }, entry: string) {
    let files: C.Files
    let parses: boolean
    if (deps.collab) ({ files, parses } = await deps.collab.freeze(draft.id))
    else {
      files = await currentFiles(await loadDraft(draft.id))
      parses = parseDocument(files, entry).parses
    }
    return { files, parses }
  }

  async function start(viewer: Viewer, draftId: string): Promise<C.Emanation> {
    const { draft } = await access(viewer, draftId)
    const document = await loadDocument(draft.documentKey)
    const procedure = procedureFor(document)
    if (await emanationOf(draft.id)) fail("CONFLICT", "L'emanazione è già stata avviata.")
    if (procedure.key === "documento") return publish(viewer, draft, document)
    if (!deps.github) fail("PRECONDITION_FAILED", "La GitHub App del repository dei documenti non è configurata.")
    // Emanating a draft based on a superseded version would undo what was published since.
    const superseded = await supersededReason(draft, viewer)
    if (superseded) fail("PRECONDITION_FAILED", superseded)
    assertRepo(document)

    if (draft.kind === "modifica") {
      if (!viewer.can("regulations:manage")) fail("FORBIDDEN", "Solo Presidente e Segretario possono emanare.")
      if (draft.state !== "approvata") fail("PRECONDITION_FAILED", "Si emana una bozza approvata.")
      const latest = await deps.diff.latestRow(draft.id)
      if (!latest) fail("PRECONDITION_FAILED", "Mancano le differenze: generale prima di emanare.")
      if (latest.status === "pending") fail("PRECONDITION_FAILED", "Le differenze sono ancora in generazione.")
      if (latest.status === "failed")
        fail("PRECONDITION_FAILED", "Le differenze non sono state generate: rigenerale prima di emanare.")
    } else {
      const right = await rectifyRight(viewer, draft.documentKey)
      if (!right) fail("FORBIDDEN", "Solo il Segretario o chi ha una sua delega può emanare una rettifica.")
      if (draft.state !== "bozza") fail("PRECONDITION_FAILED", "La rettifica è già stata emanata.")
      // Freeze the text, record the rettifica, then the differences: all before anything goes to GitHub.
      const { files, parses } = await freeze(draft, document.entry)
      const undo = async () => {
        await db.update(drafts).set({ frozenFiles: null }).where(eq(drafts.id, draft.id))
        await db
          .delete(delibere)
          .where(and(eq(delibere.draftId, draft.id), eq(delibere.kind, "rettifica"), isNull(delibere.withdrawnAt)))
        await deps.collab?.reopen(draft.id).catch(() => {})
      }
      if (!parses) {
        await undo()
        fail("PRECONDITION_FAILED", "Il testo non è valido: correggi gli errori prima di emanare.")
      }
      const stray = strayFiles(files, document.sources)
      if (stray.length) {
        await undo()
        fail("PRECONDITION_FAILED", strayFilesMessage(stray, document.sources))
      }
      await db.update(drafts).set({ frozenFiles: files, parses, updatedAt: now() }).where(eq(drafts.id, draft.id))
      await db
        .insert(delibere)
        .values({
          id: nanoid(16),
          draftId: draft.id,
          kind: "rettifica",
          date: todayInItaly(now()),
          recordedBy: viewer.person,
          recordedAt: now(),
          delegaId: right.delega?.id ?? null,
          onBehalfOf: right.delega?.grantedBy ?? null,
        })
        .onConflictDoNothing()
      const { job } = await deps.diff.generate(draft.id, viewer.person)
      await job
      const latest = await deps.diff.latestRow(draft.id)
      if (latest?.status !== "ready") {
        await undo()
        fail("PRECONDITION_FAILED", `Le differenze non sono state generate: ${latest?.error ?? "errore sconosciuto"}`)
      }
    }

    const fresh = await loadDraft(draft.id)
    const delibera = await deliberaOf(draft.id)
    if (!delibera || !fresh.frozenFiles) fail("PRECONDITION_FAILED", "Manca la delibera o il testo approvato.")
    let files: C.Files
    try {
      files = applyDelibera(
        fresh.frozenFiles,
        document.entry,
        delibera.kind === "approvazione"
          ? { kind: "approvazione", body: delibera.body as C.DeliberaBody, date: dateOf(delibera) }
          : {
              kind: "rettifica",
              date: dateOf(delibera),
              delegate: delibera.onBehalfOf ? delibera.recordedBy.name : null,
            }
      )
    } catch (error) {
      if (error instanceof DeliberaMacroMissing) fail("PRECONDITION_FAILED", error.message)
      throw error
    }
    const steps = Object.fromEntries(EMANATION_STEPS.map((k) => [k, pending()])) as Record<
      EmanationStepKey,
      EmanationStepJson
    >
    await db.insert(emanations).values({
      draftId: draft.id,
      status: "running",
      files,
      branch: `regolamenti/${draft.documentKey}-${draft.id}`,
      steps,
      startedBy: viewer.person,
      startedAt: now(),
    })
    await saveSnapshot(db, { draftId: draft.id, kind: "state", name: "Emanazione avviata", files, by: viewer.person })
    await deps.collab?.broadcast(draft.id, { type: "state", state: fresh.state }).catch(() => {})
    void advance(draft.id)
    return view(draft.id)
  }

  /** Nothing of a private document goes to GitHub (nor to the LLM, email or Telegram). */
  function assertRepo(document: { key: string; storage: string }) {
    if (document.storage !== "repo")
      throw new Error(`${document.key} is a private document: it never leaves the backend`)
  }

  const skippedNotice = (): EmanationStepJson => ({
    state: "skipped",
    url: null,
    at: now().toISOString(),
    detail: "Nessuna notifica per questo documento",
  })

  const allSteps = (state: EmanationStepJson["state"], detail: string | null) =>
    Object.fromEntries(
      EMANATION_STEPS.map((k) => [
        k,
        { state, url: null, at: state === "pending" ? null : now().toISOString(), detail },
      ])
    ) as Record<EmanationStepKey, EmanationStepJson>

  /**
   * "Pubblica" (procedure `documento`, `regulations:manage`): freezes the text, then a private document is published in
   * the database at once, a repository one goes through the GitHub App like an emanation, without notices.
   */
  async function publish(
    viewer: Viewer,
    draft: Awaited<ReturnType<typeof loadDraft>>,
    document: Awaited<ReturnType<typeof loadDocument>>
  ): Promise<C.Emanation> {
    if (!viewer.can("regulations:manage")) fail("FORBIDDEN", "Solo Presidente e Segretario possono pubblicare.")
    if (draft.kind !== "modifica" || draft.state !== "bozza")
      fail("PRECONDITION_FAILED", "Si pubblica una bozza non ancora pubblicata.")
    if (document.storage === "repo" && !deps.github)
      fail("PRECONDITION_FAILED", "La GitHub App del repository dei documenti non è configurata.")
    const superseded = await supersededReason(draft, viewer)
    if (superseded) fail("PRECONDITION_FAILED", superseded)
    const { files, parses } = await freeze(draft, document.entry)
    // The frozen text is the claim: a second "Pubblica" while this one runs finds it and refuses, so it can't publish
    // twice (nor reopen the text under this one).
    const claimed = await db
      .update(drafts)
      .set({ frozenFiles: files, parses, updatedAt: now() })
      .where(and(eq(drafts.id, draft.id), eq(drafts.state, "bozza"), isNull(drafts.frozenFiles)))
      .returning({ id: drafts.id })
    if (!claimed.length) fail("CONFLICT", "La pubblicazione è già in corso.")
    const reopen = async () => {
      await db.update(drafts).set({ frozenFiles: null }).where(eq(drafts.id, draft.id))
      await deps.collab?.reopen(draft.id).catch(() => {})
    }
    if (!parses) {
      await reopen()
      fail("PRECONDITION_FAILED", "Il testo non è valido: correggi gli errori prima di pubblicare.")
    }
    const stray = strayFiles(files, document.sources)
    if (stray.length) {
      await reopen()
      fail("PRECONDITION_FAILED", strayFilesMessage(stray, document.sources))
    }

    if (document.storage === "private") {
      try {
        // The emanation record is written in the same transaction as the version and the draft's state.
        await deps.regulations.internal.publishPrivate(viewer, draft, files, async (tx, versionId) => {
          await tx.insert(emanations).values({
            draftId: draft.id,
            status: "done",
            files,
            branch: "",
            versionId,
            steps: allSteps("skipped", "Documento privato: pubblicato solo nella dashboard"),
            startedBy: viewer.person,
            startedAt: now(),
            finishedAt: now(),
          })
        })
      } catch (error) {
        await reopen()
        throw error
      }
      await saveSnapshot(db, { draftId: draft.id, kind: "state", name: "Pubblicata", files, by: viewer.person })
      await deps.collab?.broadcast(draft.id, { type: "state", state: "pubblicata" }).catch(() => {})
      return view(draft.id)
    }

    try {
      await db.insert(emanations).values({
        draftId: draft.id,
        status: "running",
        files,
        branch: `documenti/${draft.documentKey}-${draft.id}`,
        steps: {
          ...allSteps("pending", null),
          email: skippedNotice(),
          telegram: skippedNotice(),
        },
        startedBy: viewer.person,
        startedAt: now(),
      })
    } catch (error) {
      // Without a record nothing can resume it: give the text back. With one (it committed), polling resumes it.
      if (!(await emanationOf(draft.id))) await reopen()
      throw error
    }
    await saveSnapshot(db, {
      draftId: draft.id,
      kind: "state",
      name: "Pubblicazione avviata",
      files,
      by: viewer.person,
    })
    await deps.collab?.broadcast(draft.id, { type: "state", state: draft.state }).catch(() => {})
    void advance(draft.id)
    return view(draft.id)
  }

  // ------------------------------------------------------------------------------------------------------------------
  // Steps
  // ------------------------------------------------------------------------------------------------------------------

  type Row = NonNullable<Awaited<ReturnType<typeof emanationOf>>>
  type Outcome = "done" | "wait" | "skip"

  async function stepPr(e: Row): Promise<Outcome> {
    const gh = deps.github as LegalGitHub
    const draft = await loadDraft(e.draftId)
    const document = await loadDocument(draft.documentKey)
    assertRepo(document)
    const delibera = await deliberaOf(draft.id)
    // The rri procedure carries the delibera and the LLM's categories; a documento only its publication date.
    const line = delibera
      ? `${deliberaLine(delibera)}.`
      : `Pubblicato da ${e.startedBy.name} il ${italianDate(todayInItaly(e.startedAt))}.`
    let pr = e.prNumber ? await gh.getPullRequest(e.prNumber) : await gh.findPullRequest(e.branch)
    if (!pr) {
      await gh.commitToBranch({
        branch: e.branch,
        base: config.baseBranch,
        dir: document.dir,
        sourceGlobs: document.sources,
        files: e.files,
        message: `${document.key}: ${draft.title}\n\n${line} Generato dalla dashboard.`,
      })
      const categories = delibera ? ((await deps.diff.latestRow(draft.id))?.categories ?? []) : []
      pr = await gh.openPullRequest({
        branch: e.branch,
        base: config.baseBranch,
        title: `${document.title}: ${draft.title}`,
        body: [
          line,
          "",
          ...categories.map((c) => `- **${c.title}**: ${c.summary}`),
          ...(categories.length ? [""] : []),
          delibera
            ? "Generato dalla dashboard dei documenti, dopo l'approvazione: si unisce da solo quando la CI passa. Non modificare a mano."
            : "Generato dalla dashboard dei documenti: si unisce da solo quando la CI passa. Non modificare a mano.",
        ].join("\n"),
      })
    }
    if (!pr.merged) await gh.enableAutoMerge(pr.number)
    await setStep(
      e.draftId,
      "pr",
      { state: "done", url: pr.url, at: now().toISOString(), detail: `#${pr.number}` },
      { prNumber: pr.number }
    )
    return "done"
  }

  async function stepChecks(e: Row): Promise<Outcome> {
    const pr = await (deps.github as LegalGitHub).getPullRequest(e.prNumber as number)
    if (pr.merged || pr.checks === "success") {
      await setStep(e.draftId, "checks", { state: "done", url: pr.url, at: now().toISOString(), detail: null })
      return "done"
    }
    if (pr.checks === "failure") throw new Error("La CI del repository dei documenti è fallita: controlla la PR.")
    if (pr.state === "closed") throw new Error("La PR è stata chiusa senza unirla.")
    await setStep(e.draftId, "checks", { state: "running", url: pr.url, detail: "In attesa della CI" })
    return "wait"
  }

  async function stepMerge(e: Row): Promise<Outcome> {
    const pr = await (deps.github as LegalGitHub).getPullRequest(e.prNumber as number)
    if (pr.merged && pr.mergeSha) {
      await setStep(
        e.draftId,
        "merge",
        { state: "done", url: pr.url, at: now().toISOString(), detail: pr.mergeSha.slice(0, 7) },
        { mergeSha: pr.mergeSha }
      )
      return "done"
    }
    if (pr.state === "closed") throw new Error("La PR è stata chiusa senza unirla.")
    await setStep(e.draftId, "merge", { state: "running", url: pr.url, detail: "In attesa dell'auto-merge" })
    return "wait"
  }

  async function stepTag(e: Row): Promise<Outcome> {
    const gh = deps.github as LegalGitHub
    const draft = await loadDraft(e.draftId)
    const document = await loadDocument(draft.documentKey)
    const delibera = await deliberaOf(draft.id)
    // Dated by the delibera (rri), or by the day the publication started (documento).
    const date = delibera ? dateOf(delibera) : todayInItaly(e.startedAt)
    let tag = e.tag
    if (!tag) {
      const stem = `${document.tagPrefix}v${date.replace(/-/g, ".")}`
      for (let n = 1; ; n++) {
        const candidate = n === 1 ? stem : `${stem}.${n}`
        const [taken] = await db
          .select({ id: versions.id })
          .from(versions)
          .where(and(eq(versions.documentKey, document.key), eq(versions.tag, candidate)))
        const existing = await gh.tagSha(candidate)
        if (!taken && (!existing || existing === e.mergeSha)) {
          tag = candidate
          break
        }
      }
      await db.update(emanations).set({ tag }).where(eq(emanations.draftId, e.draftId))
    }
    if (!(await gh.tagSha(tag))) await gh.createTag(tag, e.mergeSha as string)
    let versionId = e.versionId
    if (!versionId) {
      const [latest] = await db
        .select()
        .from(versions)
        .where(eq(versions.documentKey, document.key))
        .orderBy(desc(versions.publishedAt))
        .limit(1)
      versionId = nanoid(16)
      await db.insert(versions).values({
        id: versionId,
        documentKey: document.key,
        tag,
        label: tag.slice(document.tagPrefix.length),
        origin: "draft",
        entry: document.entry,
        files: e.files,
        sourceHash: await sourceHash({ entry: document.entry, files: e.files, assets: latest?.assetsBlob ?? "" }),
        commitSha: e.mergeSha,
        draftId: draft.id,
        publishedAt: now(),
        assetsBlob: latest?.assetsBlob ?? null,
      })
      await db.update(emanations).set({ versionId }).where(eq(emanations.draftId, e.draftId))
      const final = emanateRule(procedureFor(document), draft.kind)?.to ?? "emanata"
      await db
        .update(drafts)
        .set({ state: final, emanatedAt: now(), stateChangedAt: now(), updatedAt: now() })
        .where(eq(drafts.id, draft.id))
      await saveSnapshot(db, {
        draftId: draft.id,
        kind: "state",
        name: `${final === "pubblicata" ? "Pubblicata" : "Emanata"} (${tag})`,
        files: e.files,
        by: null,
      })
    }
    await setStep(e.draftId, "tag", {
      state: "done",
      url: `https://github.com/${gh.repo}/tree/${tag}`,
      at: now().toISOString(),
      detail: tag,
    })
    return "done"
  }

  async function stepRelease(e: Row): Promise<Outcome> {
    const gh = deps.github as LegalGitHub
    const draft = await loadDraft(e.draftId)
    const document = await loadDocument(draft.documentKey)
    const tag = e.tag as string
    const release = await gh.releaseByTag(tag)
    const official = release?.assets.find((a) => a.name === document.outputs.pdf)
    if (!release || !official) {
      await setStep(e.draftId, "release", { state: "running", detail: "In attesa della release della CI" })
      return "wait"
    }
    // The differences PDF exists only in the rri procedure (a documento has no LLM differences).
    const delibera = await deliberaOf(draft.id)
    if (delibera) {
      const differencesName = `differenze-${tag}.pdf`
      const differences = await deps.diff.renderPdf(draft.id, { newLabel: tag, subtitle: deliberaLine(delibera) })
      if (!release.assets.some((a) => a.name === differencesName))
        await gh.uploadAsset(release.id, differencesName, differences, "application/pdf")
    }
    const pdf = await gh.downloadAsset(official.id)
    const hash = sha256(pdf)
    await db.insert(blobs).values({ hash, contentType: "application/pdf", content: pdf }).onConflictDoNothing()
    await db
      .update(versions)
      .set({ pdfBlob: hash, releaseUrl: release.url })
      .where(eq(versions.id, e.versionId as string))
    await setStep(
      e.draftId,
      "release",
      { state: "done", url: release.url, at: now().toISOString(), detail: null },
      { releaseId: release.id }
    )
    return "done"
  }

  async function filesForNotice(e: Row) {
    const draft = await loadDraft(e.draftId)
    const document = await loadDocument(draft.documentKey)
    const [version] = await db
      .select()
      .from(versions)
      .where(eq(versions.id, e.versionId as string))
    const [official] = version?.pdfBlob ? await db.select().from(blobs).where(eq(blobs.hash, version.pdfBlob)) : []
    const diffRow = await deps.diff.latestRow(draft.id)
    const [differences] = diffRow?.pdfBlob ? await db.select().from(blobs).where(eq(blobs.hash, diffRow.pdfBlob)) : []
    return { draft, document, version, official, differences, categories: diffRow?.categories ?? [] }
  }

  /** The new official text first, then the differences: whichever exist. */
  function noticeFiles(
    officialName: string,
    tag: string,
    official: { content: Uint8Array } | undefined,
    differences: { content: Uint8Array } | undefined
  ) {
    return [
      ...(official ? [{ filename: officialName, content: official.content }] : []),
      ...(differences ? [{ filename: `differenze-${tag}.pdf`, content: differences.content }] : []),
    ]
  }

  function oppositionDeadline(kind: C.DraftKind) {
    return kind === "modifica" ? todayInItaly(deadlineAt(todayInItaly(now()), 10)) : null
  }

  /** Only the rri procedure notifies the Soci, and never about a private document. */
  async function skipNotice(e: Row, key: "email" | "telegram"): Promise<boolean> {
    const document = await loadDocument((await loadDraft(e.draftId)).documentKey)
    if (document.procedure === "rri" && document.storage === "repo") return false
    await setStep(e.draftId, key, {
      state: "skipped",
      at: now().toISOString(),
      detail: "Nessuna notifica per questo documento",
    })
    return true
  }

  async function stepEmail(e: Row): Promise<Outcome> {
    if (await skipNotice(e, "email")) return "skip"
    const { draft, document, official, differences, categories } = await filesForNotice(e)
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    const tag = e.tag as string
    const deadline = oppositionDeadline(draft.kind)
    const dashboardUrl = config.webUrl(draft.id, document.key)
    // Self-contained: the Soci can't open the private repository or the dashboard, so both PDFs are attached.
    const attachments = noticeFiles(document.outputs.pdf, tag, official, differences)
    const cc = (config.emailCc ?? []).filter((a) => a !== config.emailTo)
    await sendOnce(
      db,
      {
        key: `emanation:${draft.id}:email`,
        channel: "email",
        kind: "emanazione",
        // Everyone it went to, CC included, so the send stays provable.
        recipients: [config.emailTo, ...cc],
        subject: `${document.title}: nuova versione ${tag}`,
        draftId: draft.id,
      },
      () =>
        deps.notifier.email({
          to: config.emailTo,
          cc,
          from: config.emailFrom,
          replyTo: { name: "Consiglio Direttivo di PoliNetwork", address: config.replyTo },
          messageId: `<regolamenti-${draft.id}@polinetwork.org>`,
          props: {
            documentTitle: document.title,
            deliberaLine: deliberaLine(delibera),
            tag,
            attached: {
              official: official ? document.outputs.pdf : null,
              differences: differences ? `differenze-${tag}.pdf` : null,
            },
            dashboardUrl,
            categories: categories.map(({ title, summary }) => ({ title, summary })),
            oppositionDeadline: deadline ? italianDate(deadline) : null,
          },
          attachments: attachments.map((f) => ({
            filename: f.filename,
            content: f.content,
            contentType: "application/pdf",
          })),
        }),
      now
    )
    // The first notification is the legal one: its time starts the opposition window.
    if (!draft.notifiedAt) await db.update(drafts).set({ notifiedAt: now() }).where(eq(drafts.id, draft.id))
    // A rettifica on a delega is notified to the Segretario who granted it.
    if (delibera.delegaId && delibera.onBehalfOf) {
      const grantor = delibera.onBehalfOf
      const email = grantor.email ?? (await deps.directory.find(grantor.id))?.email
      if (email)
        await sendOnce(
          db,
          {
            key: `emanation:${draft.id}:delega-notice`,
            channel: "email",
            kind: "delega_usata",
            recipients: [email],
            draftId: draft.id,
            delegaId: delibera.delegaId,
          },
          () =>
            deps.notifier.delegaEmail({
              to: email,
              from: config.emailFrom,
              messageId: `<regolamenti-delega-${draft.id}@polinetwork.org>`,
              props: {
                change: "used",
                grantor: grantor.name,
                grantee: delibera.recordedBy.name,
                scope: document.title,
                expiresOn: null,
                note: null,
                actor: delibera.recordedBy.name,
                rettifica: { documentTitle: document.title, tag, dashboardUrl },
              },
            }),
          now
        )
    }
    await setStep(e.draftId, "email", {
      state: "done",
      at: now().toISOString(),
      detail: cc.length ? `${config.emailTo} (CC: ${cc.join(", ")})` : config.emailTo,
    })
    return "done"
  }

  async function stepTelegram(e: Row): Promise<Outcome> {
    if (await skipNotice(e, "telegram")) return "skip"
    if (!config.telegram) {
      await setStep(e.draftId, "telegram", {
        state: "skipped",
        at: now().toISOString(),
        detail: "Chat Telegram non configurata",
      })
      return "skip"
    }
    const { draft, document, official, differences } = await filesForNotice(e)
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    const tag = e.tag as string
    const deadline = oppositionDeadline(draft.kind)
    const dashboardUrl = config.webUrl(draft.id, document.key)
    const files = noticeFiles(document.outputs.pdf, tag, official, differences)
    const attachedText = attachedLine({
      official: official ? document.outputs.pdf : null,
      differences: differences ? `differenze-${tag}.pdf` : null,
    })
    const text = [
      `📙 <b>${telegramEscape(document.title)}</b>: nuova versione <code>${telegramEscape(tag)}</code>`,
      telegramEscape(`${deliberaLine(delibera)}.`),
      deadline ? telegramEscape(`Pareri contrari e ricorsi entro il ${italianDate(deadline)}.`) : null,
      // Only what is really attached; no repository link (it is private), the dashboard link as a labelled extra.
      attachedText ? telegramEscape(attachedText) : null,
      dashboardUrl
        ? `Per chi ha accesso alla dashboard: <a href="${telegramEscape(dashboardUrl)}">le modifiche</a>.`
        : null,
    ]
      .filter(Boolean)
      .join("\n")
    const telegram = config.telegram
    let messageIds: number[] = []
    await sendOnce(
      db,
      {
        key: `emanation:${draft.id}:telegram`,
        channel: "telegram",
        kind: "emanazione",
        recipients: [`${telegram.chatId}${telegram.topicId ? `/${telegram.topicId}` : ""}`],
        draftId: draft.id,
      },
      async (notificationId) => {
        ;({ messageIds } = await deps.notifier.telegram({
          chatId: telegram.chatId,
          idempotencyKey: notificationId,
          topicId: telegram.topicId,
          text,
          regulation: {
            documentTitle: document.title,
            draftTitle: draft.title,
            body: bodyLabel(delibera),
            deliberaDate: dateOf(delibera),
            oppositionDeadline: deadline,
            tag,
            dashboardUrl,
          },
          files: files.map((f) => ({
            filename: f.filename,
            contentType: "application/pdf",
            base64: Buffer.from(f.content).toString("base64"),
          })),
        }))
      },
      now
    )
    await setStep(e.draftId, "telegram", {
      state: "done",
      at: now().toISOString(),
      detail: messageIds.length ? `messaggi ${messageIds.join(", ")}` : null,
    })
    return "done"
  }

  const RUNNERS: Record<EmanationStepKey, (e: Row) => Promise<Outcome>> = {
    pr: stepPr,
    checks: stepChecks,
    merge: stepMerge,
    tag: stepTag,
    release: stepRelease,
    email: stepEmail,
    telegram: stepTelegram,
  }

  /**
   * Runs steps until one has to wait on GitHub, fails, or everything is done. Safe to call any time: a call while a
   * run is in progress waits for that run, so `retry` returns its outcome. Never rejects (`start` doesn't await it).
   */
  function advance(draftId: string): Promise<void> {
    const running = inFlight.get(draftId)
    if (running) return running
    const run = runSteps(draftId)
      // Recording the failure can fail too (the database went away): the cron resumes it.
      .catch((error) => deps.onError?.(error, draftId))
      .finally(() => inFlight.delete(draftId))
    inFlight.set(draftId, run)
    return run
  }

  async function runSteps(draftId: string): Promise<void> {
    let current: EmanationStepKey | null = null
    try {
      for (let guard = 0; guard < 20; guard++) {
        const e = await emanationOf(draftId)
        if (!e || e.status === "done" || e.status === "failed") return
        current = EMANATION_STEPS.find((k) => e.steps[k].state !== "done" && e.steps[k].state !== "skipped") ?? null
        if (!current) {
          await db
            .update(emanations)
            .set({ status: "done", finishedAt: now(), nextCheckAt: null })
            .where(eq(emanations.draftId, draftId))
          return
        }
        if (e.steps[current].state === "pending") await setStep(draftId, current, { state: "running" })
        const outcome = await RUNNERS[current](e)
        if (outcome === "wait") {
          await db
            .update(emanations)
            .set({ status: "waiting", nextCheckAt: new Date(now().getTime() + (config.pollSeconds ?? 30) * 1000) })
            .where(eq(emanations.draftId, draftId))
          return
        }
        await db.update(emanations).set({ status: "running" }).where(eq(emanations.draftId, draftId))
      }
    } catch (error) {
      deps.onError?.(error, draftId)
      const e = await emanationOf(draftId)
      if (current && e) {
        await setStep(draftId, current, {
          state: "failed",
          at: now().toISOString(),
          detail: error instanceof Error ? error.message : String(error),
        })
        await db
          .update(emanations)
          .set({ status: "failed", attempts: e.attempts + 1 })
          .where(eq(emanations.draftId, draftId))
      }
    }
  }

  async function view(draftId: string): Promise<C.Emanation> {
    const e = await emanationOf(draftId)
    if (!e) fail("NOT_FOUND", "Emanazione non avviata.")
    const sent = await db
      .select()
      .from(notifications)
      .where(eq(notifications.draftId, draftId))
      .orderBy(asc(notifications.createdAt))
    return {
      draftId,
      status: e.status,
      tag: e.tag,
      steps: EMANATION_STEPS.map((key) => ({ key, ...e.steps[key] })),
      startedAt: e.startedAt.toISOString(),
      startedBy: e.startedBy,
      finishedAt: e.finishedAt?.toISOString() ?? null,
      notifications: sent.map((n) => ({
        channel: n.channel,
        kind: n.kind,
        recipients: n.recipients,
        status: n.status,
        sentAt: n.sentAt?.toISOString() ?? null,
        error: n.error,
      })),
    }
  }

  async function get(viewer: Viewer, draftId: string) {
    await access(viewer, draftId)
    return view(draftId)
  }

  async function retry(viewer: Viewer, draftId: string) {
    const { draft } = await access(viewer, draftId)
    const allowed =
      draft.kind === "modifica"
        ? viewer.can("regulations:manage")
        : (await rectifyRight(viewer, draft.documentKey)) !== null
    if (!allowed) fail("FORBIDDEN", "Non puoi riprendere questa emanazione.")
    const e = await emanationOf(draft.id)
    if (!e) fail("NOT_FOUND", "Emanazione non avviata.")
    if (e.status === "done") fail("PRECONDITION_FAILED", "L'emanazione è già completa.")
    // Waiting on GitHub: check again now instead of at the next poll.
    if (e.status === "waiting" || e.status === "running") {
      await db.update(emanations).set({ nextCheckAt: null }).where(eq(emanations.draftId, draft.id))
      await advance(draft.id)
      return view(draft.id)
    }
    const steps = Object.fromEntries(
      EMANATION_STEPS.map((k) => [
        k,
        e.steps[k].state === "failed" ? { ...e.steps[k], state: "pending" as const, detail: null } : e.steps[k],
      ])
    ) as Record<EmanationStepKey, EmanationStepJson>
    await db.update(emanations).set({ status: "running", steps }).where(eq(emanations.draftId, draft.id))
    await advance(draft.id)
    return view(draft.id)
  }

  /** Cron: resumes emanations waiting on GitHub (and any left running by a restart). */
  async function tick() {
    const rows = await db
      .select({ draftId: emanations.draftId, status: emanations.status, nextCheckAt: emanations.nextCheckAt })
      .from(emanations)
      .where(inArray(emanations.status, ["running", "waiting"]))
    for (const row of rows) if (!row.nextCheckAt || row.nextCheckAt <= now()) await advance(row.draftId)
    await tickCreations()
  }

  /** GitHub webhook: a PR merged, a check finished, a release published. */
  async function onWebhook(
    event: string,
    payload: {
      pull_request?: { number: number }
      check_suite?: { pull_requests?: { number: number }[] }
      check_run?: { pull_requests?: { number: number }[] }
      release?: { tag_name: string }
    }
  ) {
    let rows: { draftId: string }[] = []
    const prs = [
      payload.pull_request?.number,
      ...(payload.check_suite?.pull_requests ?? []).map((p) => p.number),
      ...(payload.check_run?.pull_requests ?? []).map((p) => p.number),
    ].filter((n): n is number => typeof n === "number")
    if (prs.length && ["pull_request", "check_suite", "check_run"].includes(event))
      rows = await db.select({ draftId: emanations.draftId }).from(emanations).where(inArray(emanations.prNumber, prs))
    else if (event === "release" && payload.release)
      rows = await db
        .select({ draftId: emanations.draftId })
        .from(emanations)
        .where(eq(emanations.tag, payload.release.tag_name))
    else if (event === "check_suite" || event === "status")
      rows = await db
        .select({ draftId: emanations.draftId })
        .from(emanations)
        .where(and(eq(emanations.status, "waiting"), isNotNull(emanations.prNumber)))
    for (const row of rows) await advance(row.draftId)
    if (["pull_request", "check_suite", "check_run", "status"].includes(event)) await tickCreations()
  }

  // ------------------------------------------------------------------------------------------------------------------
  // New repository documents
  // ------------------------------------------------------------------------------------------------------------------

  /**
   * documents.json at the pull request's base with the new entry appended, keeping the file's formatting (never a stale
   * copy of the manifest).
   */
  function addToManifest(entry: { key: string }) {
    return (current: string | null) => {
      if (current === null) throw new Error(`${MANIFEST_PATH} non trovato nel repository dei documenti.`)
      const manifest = JSON.parse(current) as { documents?: { key?: string }[] }
      if (manifest.documents?.some((d) => d.key === entry.key))
        throw new Error("La chiave è già usata nel repository dei documenti.")
      const next = appendDocumentEntry(current, entry)
      // What the backend will read back must be valid (e.g. the template still exists at this base).
      parseManifest(next)
      return next
    }
  }

  async function setCreation(key: string, patch: Partial<DocumentCreationJson>, status?: "active" | "failed") {
    const [row] = await db.select().from(documents).where(eq(documents.key, key))
    if (!row?.creation || row.status !== "creating") return
    await db
      .update(documents)
      .set({ creation: { ...row.creation, ...patch }, updatedAt: now(), ...(status ? { status } : {}) })
      .where(and(eq(documents.key, key), eq(documents.status, "creating")))
  }

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
  /** Creations whose pull request this process is opening right now: not failed for lacking one. */
  const openingPr = new Map<string, Promise<void>>()

  /**
   * `documents.create` with storage `repo` (`regulations:manage`): the App opens a pull request adding
   * `<placement>/<key>/` from the template's skeleton and the documents.json entry (procedure `documento`), with
   * auto-merge after CI like an emanation. The document is `creating` until the merge, then its first version is what
   * the merge commit holds. A pull request that is closed, a commit that fails, or a creation whose pull request can't
   * be found after `CREATION_GRACE_MS` leaves it `failed`: the same key may be created again.
   */
  async function createDocument(viewer: Viewer, input: C.CreateDocumentInput): Promise<C.DocumentInfo> {
    if (!viewer.can("regulations:manage")) fail("FORBIDDEN", "Solo Presidente e Segretario creano documenti.")
    if (!deps.github) fail("PRECONDITION_FAILED", "La GitHub App del repository dei documenti non è configurata.")
    const gh = deps.github
    // A previous creation of this key that never got its pull request (the process stopped before opening it) is
    // settled first: its pull request is found, or, with no branch to recover, it fails and the key is free again.
    await advanceCreation(input.key, { replacing: true })
    const prepared = await deps.regulations.internal.prepareDocument(viewer, { ...input, storage: "repo" })
    const { entry } = prepared
    const branch = `documenti/nuovo-${entry.key}-${nanoid(8).replace(/[^A-Za-z0-9]/g, "x")}`
    const creation: DocumentCreationJson = {
      branch,
      prNumber: null,
      prUrl: null,
      error: null,
      startedBy: viewer.person,
      startedAt: now().toISOString(),
      sources: prepared.sources,
      assetsBlob: prepared.assetsHash,
    }
    try {
      await db.transaction(async (tx) => {
        if (prepared.replaces)
          await tx.delete(documents).where(and(eq(documents.key, entry.key), eq(documents.status, "failed")))
        await tx.insert(documents).values({
          key: entry.key,
          title: entry.title,
          dir: entry.dir,
          entry: entry.entry,
          sources: entry.sources,
          outputs: entry.outputs,
          tagPrefix: entry.tagPrefix,
          procedure: entry.procedure,
          storage: "repo",
          origin: "latex",
          template: entry.template,
          status: "creating",
          creation,
          createdAt: now(),
          updatedAt: now(),
        })
      })
    } catch (error) {
      if (String((error as { code?: string }).code ?? error).includes("23505"))
        fail("CONFLICT", "Esiste già un documento con questa chiave.")
      throw error
    }
    const opening = (async () => {
      try {
        await gh.commitToBranch({
          branch,
          base: config.baseBranch,
          dir: entry.dir,
          sourceGlobs: [],
          files: prepared.commit,
          edits: [{ path: MANIFEST_PATH, update: addToManifest(entry) }],
          message: `${entry.key}: nuovo documento «${entry.title}»\n\nCreato dalla dashboard dal modello ${entry.template}.`,
        })
        const pr = await gh.openPullRequest({
          branch,
          base: config.baseBranch,
          title: `Nuovo documento: ${entry.title}`,
          body: [
            `Crea \`${entry.dir}/\` dal modello \`${entry.template}\` e la sua voce in \`${MANIFEST_PATH}\` (procedura \`documento\`).`,
            "",
            `Richiesto da ${viewer.person.name} dalla dashboard dei documenti: si unisce da solo quando la CI passa.`,
          ].join("\n"),
        })
        await setCreation(entry.key, { prNumber: pr.number, prUrl: pr.url })
        await gh.enableAutoMerge(pr.number)
      } catch (error) {
        deps.onError?.(error, entry.key)
        const [row] = await db.select().from(documents).where(eq(documents.key, entry.key))
        // With its pull request open, a failure (auto-merge) is shown and checked again; without one, it failed.
        if (row?.creation?.prNumber)
          await setCreation(entry.key, { error: `Auto-merge non attivato: ${message(error)}` })
        else await setCreation(entry.key, { error: `La pull request non è stata aperta: ${message(error)}` }, "failed")
      }
    })()
    openingPr.set(entry.key, opening)
    await opening.finally(() => openingPr.delete(entry.key))
    void advanceCreation(entry.key)
    return deps.regulations.internal.documentView(await loadDocument(entry.key))
  }

  /**
   * The first version of a created document: the sources and assets of the merge commit, so a pull request fixed by
   * hand is imported as merged. The in-memory GitHub of development has no shared directories: there the template's
   * shared files copied at creation are kept.
   */
  async function mergedDocument(key: string, mergeSha: string, creation: DocumentCreationJson) {
    const source = githubLegalSource(deps.github as LegalGitHub, mergeSha)
    const manifest = await source.manifest()
    const entry = manifest.documents.find((d) => d.key === key)
    if (!entry) throw new Error(`${key} non è in ${MANIFEST_PATH} dopo il merge.`)
    const template = entry.template ? manifest.templates[entry.template] : null
    const { sources, assets } = await source.readDocument(entry, template)
    if (template && !Object.keys(assets.files).some((p) => p.startsWith("shared/"))) {
      const [stored] = await db.select().from(blobs).where(eq(blobs.hash, creation.assetsBlob))
      const bundle = stored ? (JSON.parse(Buffer.from(stored.content).toString("utf8")) as AssetBundle) : null
      for (const [path, content] of Object.entries(bundle?.files ?? {}))
        if (path.startsWith("shared/")) assets.files[path] = content
    }
    return { entry, sources, assetsHash: await deps.regulations.internal.storeAssets(assets) }
  }

  /**
   * Checks a creation: a pull request not yet recorded is looked up by its branch (the process may have stopped
   * before saving it); merged → the document is active with its first version; closed → failed; failing CI or
   * conflicts → an error to fix on GitHub.
   */
  function advanceCreation(key: string, options: { replacing?: boolean } = {}): Promise<void> {
    const flightKey = `document:${key}`
    const running = inFlight.get(flightKey)
    if (running) return running
    const run = (async () => {
      const [row] = await db.select().from(documents).where(eq(documents.key, key))
      if (!row || row.status !== "creating" || !row.creation || !deps.github || openingPr.has(key)) return
      const gh = deps.github
      let creation = row.creation
      if (!creation.prNumber) {
        const found = await gh.findPullRequest(creation.branch)
        if (found) {
          await setCreation(key, { prNumber: found.number, prUrl: found.url, error: null })
          if (!found.merged && found.state === "open") await gh.enableAutoMerge(found.number)
          creation = { ...creation, prNumber: found.number, prUrl: found.url }
        } else {
          // Nobody here is opening it: after the grace period (or when someone creates the key again) it failed.
          if (options.replacing || now().getTime() - new Date(creation.startedAt).getTime() > CREATION_GRACE_MS)
            await setCreation(key, { error: "La pull request non è stata aperta: puoi crearlo di nuovo." }, "failed")
          return
        }
      }
      const pr = await gh.getPullRequest(creation.prNumber as number)
      if (pr.merged && pr.mergeSha) {
        const mergeSha = pr.mergeSha
        const merged = await mergedDocument(key, mergeSha, creation)
        await db.transaction(async (tx) => {
          const [existing] = await tx.select({ id: versions.id }).from(versions).where(eq(versions.documentKey, key))
          if (!existing)
            await tx.insert(versions).values({
              id: nanoid(16),
              documentKey: key,
              tag: null,
              label: `import ${mergeSha.slice(0, 7)}`,
              origin: "import",
              entry: merged.entry.entry,
              files: merged.sources,
              sourceHash: await sourceHash({
                entry: merged.entry.entry,
                files: merged.sources,
                assets: merged.assetsHash,
              }),
              commitSha: mergeSha,
              publishedAt: now(),
              assetsBlob: merged.assetsHash,
            })
          await tx
            .update(documents)
            .set({
              title: merged.entry.title,
              dir: merged.entry.dir,
              entry: merged.entry.entry,
              sources: merged.entry.sources,
              outputs: merged.entry.outputs,
              tagPrefix: merged.entry.tagPrefix,
              template: merged.entry.template,
              procedure: merged.entry.procedure,
              status: "active",
              creation: null,
              updatedAt: now(),
            })
            .where(and(eq(documents.key, key), eq(documents.status, "creating")))
        })
      } else if (pr.state === "closed") {
        await setCreation(
          key,
          { error: "La pull request è stata chiusa senza unirla: puoi crearlo di nuovo." },
          "failed"
        )
      } else if (pr.checks === "failure") {
        // Still open: it may be fixed by hand and merge; close it on GitHub to start again.
        await setCreation(key, {
          error: "La CI del repository dei documenti è fallita: correggi la pull request, o chiudila per riprovare.",
        })
      } else if (pr.mergeable === false) {
        // E.g. two creations both appending to documents.json: auto-merge waits forever until it's resolved.
        await setCreation(key, {
          error:
            "La pull request è in conflitto con il ramo principale: risolvi il conflitto, o chiudila per riprovare.",
        })
      } else if (creation.error) await setCreation(key, { error: null })
    })()
      .catch((error) => deps.onError?.(error, key))
      .finally(() => inFlight.delete(flightKey))
    inFlight.set(flightKey, run)
    return run
  }

  async function tickCreations() {
    const rows = await db.select({ key: documents.key }).from(documents).where(eq(documents.status, "creating"))
    for (const row of rows) await advanceCreation(row.key)
  }

  /** Every delega created or revoked is notified to the Direttivo (Statuto, art. "Direttivo", comma 9). */
  async function delegaChanged(delegaId: string, change: "created" | "revoked") {
    const [d] = await db.select().from(deleghe).where(eq(deleghe.id, delegaId))
    if (!d) return
    const [doc] = d.documentKey ? await db.select().from(documents).where(eq(documents.key, d.documentKey)) : []
    await sendOnce(
      db,
      {
        key: `delega:${delegaId}:${change}`,
        channel: "email",
        kind: `delega_${change === "created" ? "creata" : "revocata"}`,
        recipients: [config.direttivoEmail],
        delegaId,
      },
      () =>
        deps.notifier.delegaEmail({
          to: config.direttivoEmail,
          from: config.emailFrom,
          messageId: `<regolamenti-delega-${delegaId}-${change}@polinetwork.org>`,
          props: {
            change,
            grantor: d.grantedBy.name,
            grantee: d.grantee.name,
            scope: doc?.title ?? null,
            expiresOn: d.expiresAt ? italianDate(todayInItaly(d.expiresAt)) : null,
            note: d.note,
            actor: (change === "revoked" ? d.revokedBy?.name : d.grantedBy.name) ?? d.grantedBy.name,
          },
        }),
      now
    )
  }

  return { start, get, retry, advance, tick, onWebhook, delegaChanged, createDocument, advanceCreation }
}

export type EmanationService = ReturnType<typeof createEmanationService>
