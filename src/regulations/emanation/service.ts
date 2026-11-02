import { and, asc, desc, eq, inArray, isNotNull } from "drizzle-orm"
import { nanoid } from "nanoid"
import {
  blobs,
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
import type { CollabControl } from "../collab/internal-client"
import { saveSnapshot } from "../collab/persistence"
import { sourceHash } from "../compile/protocol"
import type * as C from "../contract"
import { EMANATION_STEPS } from "../contract"
import { type RegulationsDb, sha256 } from "../db"
import type { DiffService } from "../diff/service"
import type { Directory } from "../directory"
import { applyDelibera, DeliberaMacroMissing, parseDocument } from "../latex"
import { deadlineAt, todayInItaly } from "../procedure"
import { fail, type RegulationsService, type Viewer } from "../service"
import type { LegalGitHub } from "./github"
import { sendOnce, telegramEscape } from "./notify"

export type EmanationNotifier = {
  email(input: {
    to: string
    from?: string
    replyTo?: { name: string; address: string }
    messageId: string
    props: {
      documentTitle: string
      deliberaLine: string
      tag: string
      releaseUrl: string
      webUrl: string | null
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
      rettifica?: { documentTitle: string; tag: string; releaseUrl: string } | null
    }
  }): Promise<void>
  telegram(payload: {
    chatId: number
    topicId: number | null
    text: string
    regulation: {
      documentTitle: string
      draftTitle: string
      body: string
      deliberaDate: string
      oppositionDeadline: string | null
      tag: string
      releaseUrl: string
    }
    files: { filename: string; contentType: string; data: Uint8Array }[]
  }): Promise<{ messageIds: number[] }>
}

export type EmanationConfig = {
  baseBranch: string
  /** soci@polinetwork.org */
  emailTo: string
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
const pending = (): EmanationStepJson => ({ state: "pending", url: null, at: null, detail: null })

/**
 * "Emana e notifica" (spec decision 10.4): a PR with the generated sources on the legal repository, auto-merged once
 * CI passes; after the merge the tag, then the release the legal CI builds, with the differences PDF attached; then
 * the email to the Soci and the Telegram post, each recorded. Every step is idempotent and the whole thing resumes
 * from where it stopped (GitHub webhook, a 30-second poll, or `emanation.retry`).
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
  const { access, loadDraft, loadDocument, currentFiles, rectifyRight, emanationOf, supersededReason } =
    deps.regulations.internal
  const busy = new Set<string>()

  async function deliberaOf(draftId: string) {
    const [row] = await db.select().from(delibere).where(eq(delibere.draftId, draftId))
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

  async function start(viewer: Viewer, draftId: string): Promise<C.Emanation> {
    const { draft } = await access(viewer, draftId)
    if (!deps.github) fail("PRECONDITION_FAILED", "La GitHub App del repository legal non è configurata.")
    if (await emanationOf(draft.id)) fail("CONFLICT", "L'emanazione è già stata avviata.")
    // Emanating a draft based on a superseded version would undo what was published since.
    const superseded = await supersededReason(draft)
    if (superseded) fail("PRECONDITION_FAILED", superseded)
    const document = await loadDocument(draft.documentKey)

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
      let files: C.Files
      let parses: boolean
      if (deps.collab) ({ files, parses } = await deps.collab.freeze(draft.id))
      else {
        files = await currentFiles(draft)
        parses = parseDocument(files, document.entry).parses
      }
      const undo = async () => {
        await db.update(drafts).set({ frozenFiles: null }).where(eq(drafts.id, draft.id))
        await db.delete(delibere).where(eq(delibere.draftId, draft.id))
        await deps.collab?.reopen(draft.id).catch(() => {})
      }
      if (!parses) {
        await undo()
        fail("PRECONDITION_FAILED", "Il testo non è valido: correggi gli errori prima di emanare.")
      }
      await db.update(drafts).set({ frozenFiles: files, parses, updatedAt: now() }).where(eq(drafts.id, draft.id))
      await db
        .insert(delibere)
        .values({
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

  // ------------------------------------------------------------------------------------------------------------------
  // Steps
  // ------------------------------------------------------------------------------------------------------------------

  type Row = NonNullable<Awaited<ReturnType<typeof emanationOf>>>
  type Outcome = "done" | "wait" | "skip"

  async function stepPr(e: Row): Promise<Outcome> {
    const gh = deps.github as LegalGitHub
    const draft = await loadDraft(e.draftId)
    const document = await loadDocument(draft.documentKey)
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    let pr = e.prNumber ? await gh.getPullRequest(e.prNumber) : await gh.findPullRequest(e.branch)
    if (!pr) {
      await gh.commitToBranch({
        branch: e.branch,
        base: config.baseBranch,
        dir: document.dir,
        sourceGlobs: document.sources,
        files: e.files,
        message: `${document.key}: ${draft.title}\n\n${deliberaLine(delibera)}. Generato dalla dashboard.`,
      })
      const categories = (await deps.diff.latestRow(draft.id))?.categories ?? []
      pr = await gh.openPullRequest({
        branch: e.branch,
        base: config.baseBranch,
        title: `${document.title}: ${draft.title}`,
        body: [
          `${deliberaLine(delibera)}.`,
          "",
          ...categories.map((c) => `- **${c.title}**: ${c.summary}`),
          "",
          "Generato dalla dashboard dei regolamenti, dopo l'approvazione: si unisce da solo quando la CI passa. Non modificare a mano.",
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
    if (pr.checks === "failure") throw new Error("La CI del repository legal è fallita: controlla la PR.")
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
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    let tag = e.tag
    if (!tag) {
      const stem = `${document.tagPrefix}v${dateOf(delibera).replace(/-/g, ".")}`
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
        files: e.files,
        sourceHash: await sourceHash({ entry: document.entry, files: e.files, assets: latest?.assetsBlob ?? "" }),
        commitSha: e.mergeSha,
        draftId: draft.id,
        publishedAt: now(),
        assetsBlob: latest?.assetsBlob ?? null,
      })
      await db.update(emanations).set({ versionId }).where(eq(emanations.draftId, e.draftId))
      await db
        .update(drafts)
        .set({ state: "emanata", emanatedAt: now(), stateChangedAt: now(), updatedAt: now() })
        .where(eq(drafts.id, draft.id))
      await saveSnapshot(db, { draftId: draft.id, kind: "state", name: `Emanata (${tag})`, files: e.files, by: null })
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
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    const differencesName = `differenze-${tag}.pdf`
    const differences = await deps.diff.renderPdf(draft.id, { newLabel: tag, subtitle: deliberaLine(delibera) })
    if (!release.assets.some((a) => a.name === differencesName))
      await gh.uploadAsset(release.id, differencesName, differences, "application/pdf")
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

  function oppositionDeadline(kind: C.DraftKind) {
    return kind === "modifica" ? todayInItaly(deadlineAt(todayInItaly(now()), 10)) : null
  }

  async function stepEmail(e: Row): Promise<Outcome> {
    const { draft, document, version, differences, categories } = await filesForNotice(e)
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    const tag = e.tag as string
    const deadline = oppositionDeadline(draft.kind)
    await sendOnce(
      db,
      {
        key: `emanation:${draft.id}:email`,
        channel: "email",
        kind: "emanazione",
        recipients: [config.emailTo],
        subject: `${document.title}: nuova versione ${tag}`,
        draftId: draft.id,
      },
      () =>
        deps.notifier.email({
          to: config.emailTo,
          from: config.emailFrom,
          replyTo: { name: "Consiglio Direttivo di PoliNetwork", address: config.replyTo },
          messageId: `<regolamenti-${draft.id}@polinetwork.org>`,
          props: {
            documentTitle: document.title,
            deliberaLine: deliberaLine(delibera),
            tag,
            releaseUrl: version?.releaseUrl ?? "",
            webUrl: config.webUrl(draft.id, document.key),
            categories: categories.map(({ title, summary }) => ({ title, summary })),
            oppositionDeadline: deadline ? italianDate(deadline) : null,
          },
          attachments: differences
            ? [{ filename: `differenze-${tag}.pdf`, content: differences.content, contentType: "application/pdf" }]
            : [],
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
                rettifica: { documentTitle: document.title, tag, releaseUrl: version?.releaseUrl ?? "" },
              },
            }),
          now
        )
    }
    await setStep(e.draftId, "email", { state: "done", at: now().toISOString(), detail: config.emailTo })
    return "done"
  }

  async function stepTelegram(e: Row): Promise<Outcome> {
    if (!config.telegram) {
      await setStep(e.draftId, "telegram", {
        state: "skipped",
        at: now().toISOString(),
        detail: "Chat Telegram non configurata",
      })
      return "skip"
    }
    const { draft, document, version, official, differences } = await filesForNotice(e)
    const delibera = (await deliberaOf(draft.id)) as typeof delibere.$inferSelect
    const tag = e.tag as string
    const deadline = oppositionDeadline(draft.kind)
    const text = [
      `📙 <b>${telegramEscape(document.title)}</b>: nuova versione <code>${telegramEscape(tag)}</code>`,
      telegramEscape(`${deliberaLine(delibera)}.`),
      deadline ? telegramEscape(`Pareri contrari e ricorsi entro il ${italianDate(deadline)}.`) : null,
      `<a href="${telegramEscape(version?.releaseUrl ?? "")}">Testo ufficiale</a> · in allegato anche le differenze (senza valore ufficiale).`,
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
      async () => {
        ;({ messageIds } = await deps.notifier.telegram({
          chatId: telegram.chatId,
          topicId: telegram.topicId,
          text,
          regulation: {
            documentTitle: document.title,
            draftTitle: draft.title,
            body: bodyLabel(delibera),
            deliberaDate: dateOf(delibera),
            oppositionDeadline: deadline,
            tag,
            releaseUrl: version?.releaseUrl ?? "",
          },
          files: [
            ...(official
              ? [{ filename: document.outputs.pdf, contentType: "application/pdf", data: official.content }]
              : []),
            ...(differences
              ? [{ filename: `differenze-${tag}.pdf`, contentType: "application/pdf", data: differences.content }]
              : []),
          ],
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

  /** Runs steps until one has to wait on GitHub, fails, or everything is done. Safe to call any time. */
  async function advance(draftId: string): Promise<void> {
    if (busy.has(draftId)) return
    busy.add(draftId)
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
    } finally {
      busy.delete(draftId)
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
  }

  /** GitHub webhook: a PR merged, a check finished, a release published. */
  async function onWebhook(
    event: string,
    payload: { pull_request?: { number: number }; release?: { tag_name: string } }
  ) {
    let rows: { draftId: string }[] = []
    if (payload.pull_request && (event === "pull_request" || event === "check_suite"))
      rows = await db
        .select({ draftId: emanations.draftId })
        .from(emanations)
        .where(eq(emanations.prNumber, payload.pull_request.number))
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

  return { start, get, retry, advance, tick, onWebhook, delegaChanged }
}

export type EmanationService = ReturnType<typeof createEmanationService>
