import { desc, eq } from "drizzle-orm"
import { DB } from "@/db"
import { blobs, documents, versions } from "@/db/schema/regulations"
import { sendRegulationDelegaEmail, sendRegulationEmanatedEmail } from "@/emails/mailer"
import { env } from "@/env"
import { idp } from "@/idp"
import { logger } from "@/logger"
import { telegram } from "@/websocket/registry"
import { createCollabControl } from "./collab/internal-client"
import { createWorkerClient } from "./compile/client"
import { type AssetBundle, sourceHash } from "./compile/protocol"
import { regulationsConfig as config } from "./config"
import { sha256 } from "./db"
import { createDiffService } from "./diff/service"
import { anthropicSummarizer, type DiffSummarizer, fakeSummarizer } from "./diff/summarizer"
import { createDirectory } from "./directory"
import { fakeGitHub, githubAppClient, type LegalGitHub } from "./emanation/github"
import { createEmanationService, type EmanationService } from "./emanation/service"
import { githubLegalSource, type LegalSource, localLegalSource } from "./legal-source"
import { createRegulationsService, type RegulationsHooks } from "./service"

export const regulationsDirectory = createDirectory(idp?.directory ?? null)

const worker = config.REGULATIONS_WORKER_URL
  ? createWorkerClient({
      url: config.REGULATIONS_WORKER_URL,
      secret: config.REGULATIONS_WORKER_SECRET,
      async loadAssets(hash) {
        const [blob] = await DB.select().from(blobs).where(eq(blobs.hash, hash))
        if (!blob) throw new Error(`asset bundle ${hash} not found`)
        return JSON.parse(Buffer.from(blob.content).toString("utf8")) as AssetBundle
      },
    })
  : null

const collab =
  config.REGULATIONS_COLLAB_INTERNAL_URL && config.REGULATIONS_INTERNAL_SECRET
    ? createCollabControl({ url: config.REGULATIONS_COLLAB_INTERNAL_URL, secret: config.REGULATIONS_INTERNAL_SECRET })
    : null
if (!collab) logger.warn("[REGULATIONS] The collab service is not configured: drafts can't be edited live")

function summarizer(): DiffSummarizer | null {
  const provider = config.REGULATIONS_LLM_PROVIDER ?? (env.NODE_ENV === "production" ? null : "fake")
  if (provider === "fake") return fakeSummarizer()
  if (provider === "anthropic") {
    const apiKey = config.REGULATIONS_LLM_API_KEY
    if (!apiKey || !config.REGULATIONS_LLM_MODEL) {
      logger.error(
        "[REGULATIONS] REGULATIONS_LLM_PROVIDER=anthropic needs REGULATIONS_LLM_API_KEY and REGULATIONS_LLM_MODEL"
      )
      return null
    }
    return anthropicSummarizer({ apiKey, model: config.REGULATIONS_LLM_MODEL, effort: config.REGULATIONS_LLM_EFFORT })
  }
  logger.warn("[REGULATIONS] No LLM provider: differences are generated without categories")
  return null
}

const hooks: RegulationsHooks = {}

/** The legal repository: the GitHub App, or (outside production) an in-memory one whose "CI" compiles with the worker. */
function legalGitHub(): LegalGitHub | null {
  const mode = config.REGULATIONS_GITHUB_MODE ?? (env.NODE_ENV === "production" ? "app" : "fake")
  if (mode === "app") {
    if (!config.REGULATIONS_GITHUB_APP_ID || !config.REGULATIONS_GITHUB_PRIVATE_KEY) {
      logger.warn("[REGULATIONS] The GitHub App is not configured: emanation is unavailable")
      return null
    }
    return githubAppClient({
      appId: config.REGULATIONS_GITHUB_APP_ID,
      privateKey: config.REGULATIONS_GITHUB_PRIVATE_KEY,
      repo: config.REGULATIONS_GITHUB_REPO,
    })
  }
  logger.warn("[REGULATIONS] Using an in-memory GitHub: emanations go nowhere")
  return fakeGitHub({
    stateFile: config.REGULATIONS_FAKE_GITHUB_STATE,
    ciDelayMs: 3000,
    releaseDelayMs: 3000,
    async buildRelease(tag, files) {
      const [document] = (await DB.select().from(documents)).filter((d) => tag.startsWith(d.tagPrefix))
      const [latest] = await DB.select()
        .from(versions)
        .where(eq(versions.documentKey, document.key))
        .orderBy(desc(versions.publishedAt))
        .limit(1)
      if (!worker || !latest?.assetsBlob) return []
      const prefix = `${document.dir}/`
      const sources = Object.fromEntries(
        [...files]
          .filter(([p]) => p.startsWith(prefix))
          .map(([p, c]) => [p.slice(prefix.length), typeof c === "string" ? c : ""])
      )
      const hash = await sourceHash({ entry: document.entry, files: sources, assets: latest.assetsBlob })
      const result = await worker.compile({
        key: `release:${tag}`,
        hash,
        entry: document.entry,
        assets: latest.assetsBlob,
        files: sources,
      })
      if (result.status !== "done" || !result.pdf) return []
      return [{ name: document.outputs.pdf, content: new Uint8Array(Buffer.from(result.pdf, "base64")) }]
    },
  }).client
}
/** Never fatal: a malformed key or a broken state file leaves emanation "not configured" and the backend running. */
function safely<T>(what: string, build: () => T): T | null {
  try {
    return build()
  } catch (err) {
    logger.error({ err }, `[REGULATIONS] ${what} could not be set up: it is disabled`)
    return null
  }
}

const github = safely("The GitHub client", legalGitHub)

function legalSource(): LegalSource | null {
  if (config.REGULATIONS_LEGAL_DIR) return localLegalSource(config.REGULATIONS_LEGAL_DIR)
  if (github && (config.REGULATIONS_GITHUB_MODE ?? (env.NODE_ENV === "production" ? "app" : "fake")) === "app")
    return githubLegalSource(github, config.REGULATIONS_GITHUB_BASE)
  return null
}

export const regulations = createRegulationsService({
  db: DB,
  directory: regulationsDirectory,
  collab,
  collabUrl: config.REGULATIONS_COLLAB_PUBLIC_URL ?? null,
  legal: legalSource(),
  compileVersion: worker
    ? async (version) => {
        const hash = await sourceHash({ entry: version.entry, files: version.files, assets: version.assets })
        const response = await worker.compile({ key: `version:${version.id}`, hash, ...version })
        if (response.status !== "done" || !response.ok || !response.pdf) return null
        const content = new Uint8Array(Buffer.from(response.pdf, "base64"))
        const blobHash = sha256(content)
        await DB.insert(blobs).values({ hash: blobHash, contentType: "application/pdf", content }).onConflictDoNothing()
        await DB.update(versions).set({ pdfBlob: blobHash }).where(eq(versions.id, version.id))
        return content
      }
    : undefined,
  hooks,
})

export const regulationsDiff = createDiffService({
  db: DB,
  regulations,
  summarizer: safely("The LLM summarizer", summarizer),
  onError: (err, draftId) => logger.error({ err, draftId }, "[REGULATIONS] diff generation failed"),
})

const dashboard = env.ESIGN_DASHBOARD_URL.replace(/\/$/, "")

export const regulationsEmanation: EmanationService | null = createEmanationService({
  db: DB,
  regulations,
  diff: regulationsDiff,
  github,
  collab,
  directory: regulationsDirectory,
  notifier: {
    email: (input) => sendRegulationEmanatedEmail(input, input.props, input.attachments),
    delegaEmail: (input) => sendRegulationDelegaEmail(input, input.props),
    telegram: (payload) => telegram().postRegulation(payload),
  },
  config: {
    baseBranch: config.REGULATIONS_GITHUB_BASE,
    emailTo: config.REGULATIONS_EMAIL_TO,
    emailCc: config.REGULATIONS_EMAIL_CC,
    emailFrom: config.REGULATIONS_EMAIL_SENDER,
    replyTo: config.REGULATIONS_EMAIL_REPLY_TO,
    direttivoEmail: config.REGULATIONS_DIRETTIVO_EMAIL,
    telegram:
      config.REGULATIONS_TELEGRAM_CHAT_ID !== undefined
        ? { chatId: config.REGULATIONS_TELEGRAM_CHAT_ID, topicId: config.REGULATIONS_TELEGRAM_TOPIC_ID ?? null }
        : null,
    pollSeconds: config.REGULATIONS_RECONCILE_SECONDS,
    webUrl: (draftId, documentKey) =>
      (config.REGULATIONS_WEB_URL ?? `${dashboard}/dashboard/regulations/drafts/{draftId}/diff`)
        .replace("{draftId}", draftId)
        .replace("{documentKey}", documentKey),
  },
  onError: (err, draftId) => logger.error({ err, draftId }, "[REGULATIONS] emanation step failed"),
})

hooks.delegaChanged = async (delegaId, change) => {
  await regulationsEmanation
    ?.delegaChanged(delegaId, change)
    .catch((err) => logger.error({ err, delegaId }, "[REGULATIONS] delega email failed"))
}

hooks.sentToApproval = async (draftId, by) => {
  // The transition already happened: a failure here shows as a failed diff, which can be regenerated.
  await regulationsDiff
    .generate(draftId, by)
    .catch((err) => logger.error({ err, draftId }, "[REGULATIONS] diff not started"))
}
