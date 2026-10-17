import { createHash, randomBytes, X509Certificate } from "node:crypto"
import { type Drive, DriveError, MAX_PDF_BYTES } from "./drive/types"
import { EsignError } from "./errors"
import { identityOf, titleCase } from "./identity"
import { PdfError } from "./pdf/incremental"
import { inspectPdf, type PdfInfo } from "./pdf/inspect"
import { finalizeSignature, type PreparedSignature, prepareSignature, SignatureError } from "./pdf/pades"
import { type PlacementInput, validatePlacement } from "./placement"
import type {
  DocumentMeta,
  DocumentRecord,
  EmailJson,
  EsignStore,
  Job,
  OutputJson,
  PlacementJson,
  Profile,
  Signer,
  SigningRequest,
} from "./store"
import { cieChain } from "./trust"
import { checkRevocation, type RevocationResult } from "./trust/ocsp"

/** Who is calling, and what the IdP lets them do. */
export type Caller = { sub: string; canManage: boolean }

export type Mailer = {
  signatureRequest(
    to: string,
    props: { signerName: string; requestedBy: string; title: string; role: string | null; url: string }
  ): Promise<boolean>
  signedDocument(
    to: string[],
    props: {
      title: string
      signers: { name: string; role: string | null }[]
      message: string | null
      link: string | null
    },
    attachment: { filename: string; content: Uint8Array; contentType: string } | null
  ): Promise<boolean>
}

type Logger = {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export type ServiceOptions = {
  store: EsignStore
  drive: Drive | null
  mailer: Mailer
  logger: Logger
  /** Dashboard origin, for links in emails. */
  dashboardUrl: string
  /** Accept certificates that are not issued by the CIE CAs (development keys). */
  allowTestCertificates: boolean
  /**
   * OCSP for CIE certificates: "require" refuses when the status can't be established, "prefer" refuses only revoked
   * certificates and records an unknown status, "off" skips it.
   */
  revocation?: "require" | "prefer" | "off"
  /** Replaces the OCSP check in tests. */
  checkRevocation?: typeof checkRevocation
  /** Replaces the CIE CA check in tests. */
  trust?: typeof cieChain
  now?: () => Date
  jobTtlMs?: number
}

/**
 * Emails attach PDFs up to this size; larger ones are linked from OneDrive. Graph's sendMail takes the MIME message
 * base64-encoded, holding the attachment base64-encoded: about 1.8× the PDF, under Graph's 4 MB request limit.
 */
const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
/** A delivery attempt older than this is presumed dead and may be resumed. */
const DELIVERY_CLAIM_MS = 5 * 60 * 1000
const STAGED_TTL_MS = 24 * 60 * 60 * 1000
const MAX_SIGNERS = 10

export type CreateRequestInput = {
  title: string
  documentId: string
  signers: { sub: string; role: string | null; placement: PlacementInput }[]
  ordered: boolean
  output: { folderId: string; fileName: string } | null
  email: { to: string[]; message: string | null } | null
}

export type RequestView = SigningRequest & {
  /** Signers who may sign now. */
  turn: string[]
  myTurn: boolean
  signedCount: number
  createdByName: string
}

const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex")
const b64 = (data: Uint8Array) => Buffer.from(data).toString("base64")
const fromB64 = (data: string) => new Uint8Array(Buffer.from(data, "base64"))

/** "Verbale CD.pdf" with characters OneDrive refuses removed. */
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|#%]/g, " ")
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180)
  const base = cleaned.replace(/\.pdf$/i, "").trim() || "document"
  return `${base}.pdf`
}

function formatRomeDate(date: Date) {
  return new Intl.DateTimeFormat("it-IT", {
    timeZone: "Europe/Rome",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date)
}

/** Signers who may sign now: the first pending one in order, or every pending one. */
export function turnOf(request: SigningRequest): Signer[] {
  if (request.status !== "in_progress") return []
  const pending = request.signers.filter((s) => s.status === "pending")
  return request.ordered ? pending.slice(0, 1) : pending
}

export function createEsignService(options: ServiceOptions) {
  const { store, drive, mailer, logger } = options
  const now = options.now ?? (() => new Date())
  const jobTtlMs = options.jobTtlMs ?? 10 * 60 * 1000
  const infoCache = new Map<string, PdfInfo>()
  const revocationPolicy = options.revocation ?? "prefer"

  /** Applies the revocation policy to a trusted CIE certificate; null when not checked. */
  async function revocationOf(cert: X509Certificate, issuer: X509Certificate | null): Promise<RevocationResult | null> {
    if (!issuer || revocationPolicy === "off") return null
    const result = await (options.checkRevocation ?? checkRevocation)(cert, issuer, { now: now() })
    if (result.status === "revoked")
      throw new EsignError("certificate_invalid", "This CIE certificate has been revoked")
    if (result.status === "unknown") {
      logger.warn({ detail: result.detail }, "[ESIGN] revocation status unknown")
      if (revocationPolicy === "require")
        throw new EsignError(
          "unavailable",
          "Couldn't check whether the CIE is still valid. Try again in a few minutes."
        )
    }
    return result
  }

  async function info(sha256: string, content: Uint8Array): Promise<PdfInfo> {
    const cached = infoCache.get(sha256)
    if (cached) return cached
    const result = await inspectPdf(content)
    if (infoCache.size > 100) infoCache.delete(infoCache.keys().next().value as string)
    infoCache.set(sha256, result)
    return result
  }

  function canView(caller: Caller, request: SigningRequest) {
    return caller.canManage || request.createdBySub === caller.sub || request.signers.some((s) => s.sub === caller.sub)
  }

  async function requestFor(caller: Caller, id: string): Promise<SigningRequest> {
    const request = await store.getRequest(id)
    if (!request || !canView(caller, request)) throw new EsignError("not_found", "Request not found")
    return request
  }

  async function profileName(sub: string) {
    return (await store.getProfile(sub))?.name ?? "A PoliNetwork member"
  }

  async function view(caller: Caller, request: SigningRequest): Promise<RequestView> {
    const turn = turnOf(request).map((s) => s.sub)
    return {
      ...request,
      turn,
      myTurn: turn.includes(caller.sub),
      signedCount: request.signers.filter((s) => s.status === "signed").length,
      createdByName: await profileName(request.createdBySub),
    }
  }

  async function stage(caller: Caller, fileName: string, bytes: Uint8Array, source: DocumentMeta["source"]) {
    if (bytes.length > MAX_PDF_BYTES) throw new EsignError("pdf_invalid", "The PDF is larger than 30 MB")
    if (Buffer.from(bytes.subarray(0, 1024)).indexOf("%PDF-") < 0)
      throw new EsignError("pdf_invalid", "This file is not a PDF")
    const sha256 = sha256Hex(bytes)
    let pdf: PdfInfo
    try {
      pdf = await info(sha256, bytes)
    } catch (error) {
      if (error instanceof PdfError) throw new EsignError("pdf_invalid", error.message)
      throw error
    }
    if (pdf.pages.length === 0) throw new EsignError("pdf_invalid", "The PDF has no pages")
    const document = await store.insertDocument({
      requestId: null,
      version: 0,
      fileName: safeFileName(fileName),
      content: bytes,
      sha256,
      size: bytes.length,
      pages: pdf.pages.length,
      source,
      createdBySub: caller.sub,
    })
    return { document, pdf }
  }

  async function notifyTurn(request: SigningRequest, except: string | null) {
    const requestedBy = await profileName(request.createdBySub)
    for (const signer of turnOf(request)) {
      if (signer.sub === except) continue
      const profile = await store.getProfile(signer.sub)
      if (!profile?.email) continue
      const sent = await mailer
        .signatureRequest(profile.email, {
          signerName: profile.name.split(" ")[0] ?? profile.name,
          requestedBy,
          title: request.title,
          role: signer.role,
          url: `${options.dashboardUrl}/dashboard/esign/requests/${request.id}`,
        })
        .catch((error) => {
          logger.error({ error, requestId: request.id }, "[ESIGN] cannot send the signature request email")
          return false
        })
      if (sent)
        await store.addEvent({ requestId: request.id, actorSub: null, type: "notified", data: { sub: signer.sub } })
    }
  }

  // ── Ticket resolution for the agent ──────────────────────────────────────────────────────────────────────────

  async function resolveTicket(ticket: string, allowed: Job["status"][]): Promise<Job> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new EsignError("ticket_invalid", "This signing link is not valid")
    const job = await store.getJobByTicketHash(sha256Hex(ticket))
    if (!job) throw new EsignError("ticket_invalid", "This signing link is not valid")
    if (job.status === "completed") throw new EsignError("job_done", "This document is already signed")
    if (job.status === "cancelled")
      throw new EsignError("job_cancelled", "This signature was cancelled in the dashboard")
    if (job.status === "expired" || job.expiresAt < now()) {
      await store.transitionJob(job.id, ["pending", "prepared"], { status: "expired" })
      throw new EsignError("job_expired", "This signing link expired. Start again from the dashboard.")
    }
    if (!allowed.includes(job.status)) throw new EsignError("conflict", "The signature is not ready")
    return job
  }

  /** The request and signer of an open job, checked again: either may have changed since the job started. */
  async function jobContext(job: Job) {
    const request = await store.getRequest(job.requestId)
    const signer = request?.signers.find((s) => s.id === job.signerId)
    if (!request || !signer) throw new EsignError("ticket_invalid", "This signing link is not valid")
    if (request.status !== "in_progress" || signer.status !== "pending")
      throw new EsignError("job_done", "This request no longer needs your signature")
    const current = await store.latestDocument(request.id)
    if (!current) throw new EsignError("not_found", "Document not found")
    if (current.version !== job.baseVersion)
      throw new EsignError("document_changed", "Someone else signed in the meantime. Start again from the dashboard.")
    return { request, signer, current }
  }

  /**
   * Uploads and emails a completed request's PDF. A claim makes one worker do it at a time; a crash leaves it pending,
   * and the sweep resumes it once the claim is stale.
   */
  async function deliver(requestId: string, retry = false) {
    const at = now()
    if (!(await store.claimDelivery(requestId, at, new Date(at.getTime() - DELIVERY_CLAIM_MS), retry))) return
    const request = await store.getRequest(requestId)
    if (!request || request.status !== "completed") return
    const document = await store.latestDocument(requestId)
    if (!document) return
    const delivery = {
      status: "delivered" as "delivered" | "failed",
      driveItem: request.delivery?.driveItem ?? null,
      emailedTo: request.delivery?.emailedTo ?? [],
      error: null as string | null,
      attemptedAt: now().toISOString(),
    }
    try {
      if (request.output && !delivery.driveItem) {
        if (!drive) throw new Error("OneDrive is not configured")
        const item = await drive.upload(request.output.folderId, request.output.fileName, document.content)
        delivery.driveItem = { id: item.id, name: item.name, webUrl: item.webUrl }
        await store.addEvent({
          requestId,
          actorSub: null,
          type: "uploaded",
          data: { name: item.name, path: request.output.folderPath },
        })
      }
      if (request.email && request.email.to.length > 0 && delivery.emailedTo.length === 0) {
        const attach = document.size <= MAX_ATTACHMENT_BYTES
        if (!attach && !delivery.driveItem?.webUrl)
          throw new Error("The PDF is too large to email and there is no OneDrive link to send instead")
        const sent = await mailer.signedDocument(
          request.email.to,
          {
            title: request.title,
            signers: request.signers.map((s) => ({ name: s.name, role: s.role })),
            message: request.email.message,
            link: attach ? null : (delivery.driveItem?.webUrl ?? null),
          },
          attach ? { filename: document.fileName, content: document.content, contentType: "application/pdf" } : null
        )
        if (!sent) throw new Error("The email could not be sent")
        delivery.emailedTo = request.email.to
        await store.addEvent({ requestId, actorSub: null, type: "emailed", data: { to: request.email.to } })
      }
    } catch (error) {
      delivery.status = "failed"
      delivery.error = error instanceof Error ? error.message : String(error)
      logger.error({ error, requestId }, "[ESIGN] delivery failed")
      await store.addEvent({ requestId, actorSub: null, type: "delivery_failed", data: { error: delivery.error } })
    }
    await store.updateRequest(requestId, { delivery })
  }

  /** Stores a signed version, binds the signer's CIE, then delivers or asks the next signer. */
  async function commitSigned(input: {
    request: SigningRequest
    signer: Signer
    current: DocumentRecord
    job: Job
    signed: Uint8Array
    sha256: string
    identity: ReturnType<typeof identityOf>
    method: "agent" | "upload"
    revocation: RevocationResult | null
  }) {
    const { request, signer, current, job, signed, sha256, identity } = input
    const remaining = request.signers.filter((s) => s.status === "pending" && s.id !== signer.id).length
    const result = await store.commitSignature({
      jobId: job.id,
      requestId: request.id,
      baseVersion: job.baseVersion,
      document: {
        requestId: request.id,
        version: job.baseVersion + 1,
        fileName: current.fileName,
        content: signed,
        sha256,
        size: signed.length,
        pages: current.pages,
        source: current.source,
        createdBySub: job.sub,
      },
      signer: {
        id: signer.id,
        fiscalCode: identity.fiscalCode,
        certificateSubject: identity.subject,
        certificateIssuer: identity.issuer,
      },
      complete: remaining === 0,
      identity: { sub: signer.sub, fiscalCode: identity.fiscalCode, certificateSubject: identity.subject },
      event: {
        requestId: request.id,
        actorSub: job.sub,
        type: "signed",
        data: {
          name: identity.name,
          fiscalCode: identity.fiscalCode,
          version: job.baseVersion + 1,
          issuer: identity.issuer,
          method: input.method,
          revocation: input.revocation?.status ?? "not_checked",
        },
      },
    })
    if (result === "mismatch") throw new EsignError("signer_mismatch", `This CIE does not belong to ${signer.name}`)
    if (result === "conflict")
      throw new EsignError("document_changed", "Someone else signed in the meantime. Start again from the dashboard.")

    const updated = await store.getRequest(request.id)
    if (updated?.status === "completed") {
      void deliver(request.id).catch((error) => logger.error({ error }, "[ESIGN] delivery crashed"))
    } else if (updated) {
      void notifyTurn(updated, null).catch((error) => logger.error({ error }, "[ESIGN] notification crashed"))
    }
    logger.info(
      { requestId: request.id, version: job.baseVersion + 1, remaining, method: input.method },
      "[ESIGN] signature added"
    )
    return { status: "completed" as const, request: { status: updated?.status ?? request.status, remaining } }
  }

  return {
    get driveLabel() {
      return drive?.label ?? null
    },

    async syncProfile(caller: Caller, profile: { name: string; email: string | null }): Promise<Profile> {
      return store.upsertProfile({ sub: caller.sub, name: profile.name.trim().slice(0, 120), email: profile.email })
    },

    async listProfiles(): Promise<Profile[]> {
      return store.listProfiles()
    },

    async resetIdentity(sub: string) {
      await store.setProfileIdentity(sub, null)
    },

    async listDrive(folderId?: string) {
      if (!drive) throw new EsignError("unavailable", "OneDrive is not configured")
      try {
        return await drive.list(folderId)
      } catch (error) {
        if (error instanceof DriveError) throw new EsignError("not_found", error.message)
        throw error
      }
    },

    async stageUpload(caller: Caller, fileName: string, bytes: Uint8Array) {
      return stage(caller, fileName, bytes, { kind: "upload" })
    },

    async stageDriveItem(caller: Caller, itemId: string) {
      if (!drive) throw new EsignError("unavailable", "OneDrive is not configured")
      try {
        const { item, bytes } = await drive.download(itemId)
        return await stage(caller, item.name, bytes, {
          kind: "drive",
          itemId: item.id,
          name: item.name,
          webUrl: item.webUrl,
        })
      } catch (error) {
        if (error instanceof DriveError)
          throw new EsignError(error.code === "not_found" ? "not_found" : "pdf_invalid", error.message)
        throw error
      }
    },

    /** A document version's bytes and what is in it, for the viewer. */
    async document(caller: Caller, documentId: string) {
      const document = await store.getDocument(documentId)
      if (!document) throw new EsignError("not_found", "Document not found")
      if (document.requestId) await requestFor(caller, document.requestId)
      else if (document.createdBySub !== caller.sub && !caller.canManage)
        throw new EsignError("not_found", "Document not found")
      const { content, ...meta } = document
      return { meta, content, pdf: await info(document.sha256, content) }
    },

    async createRequest(caller: Caller, input: CreateRequestInput): Promise<RequestView> {
      if (!caller.canManage) throw new EsignError("forbidden", "You cannot create signature requests")
      const document = await store.getDocumentMeta(input.documentId)
      if (!document || document.requestId !== null || (document.createdBySub !== caller.sub && !caller.canManage))
        throw new EsignError("not_found", "Upload the document again")
      if (input.signers.length === 0 || input.signers.length > MAX_SIGNERS)
        throw new EsignError("bad_request", `Choose between 1 and ${MAX_SIGNERS} signers`)
      if (new Set(input.signers.map((s) => s.sub)).size !== input.signers.length)
        throw new EsignError("bad_request", "Each person can sign once")
      const signers: { sub: string; name: string; role: string | null; placement: PlacementJson }[] = []
      for (const s of input.signers) {
        const profile = await store.getProfile(s.sub)
        if (!profile) throw new EsignError("bad_request", "A signer is not a dashboard user")
        signers.push({
          sub: s.sub,
          name: profile.name,
          role: s.role?.trim() || null,
          placement: validatePlacement(s.placement, document.pages),
        })
      }
      let output: OutputJson | null = null
      if (input.output) {
        if (!drive) throw new EsignError("unavailable", "OneDrive is not configured")
        const folder = await drive.folder(input.output.folderId)
        if (!folder) throw new EsignError("bad_request", "Choose a folder in the shared drive")
        output = { folderId: folder.id, folderPath: folder.path, fileName: safeFileName(input.output.fileName) }
      }
      if (input.email?.to.length && !output && document.size > MAX_ATTACHMENT_BYTES * 0.9)
        throw new EsignError(
          "bad_request",
          "The PDF is too large to email as an attachment: also save it to OneDrive so the email can link it"
        )
      const email: EmailJson | null =
        input.email && input.email.to.length > 0
          ? {
              to: [...new Set(input.email.to.map((e) => e.trim().toLowerCase()))],
              message: input.email.message?.trim() || null,
            }
          : null
      const request = await store.createRequest({
        title: input.title.trim(),
        ordered: input.ordered,
        output,
        email,
        createdBySub: caller.sub,
        documentId: document.id,
        signers,
      })
      await store.addEvent({
        requestId: request.id,
        actorSub: caller.sub,
        type: "created",
        data: { signers: signers.length },
      })
      await notifyTurn(request, caller.sub)
      return view(caller, request)
    },

    async listRequests(caller: Caller, scope: "inbox" | "mine" | "all") {
      if (scope === "all" && !caller.canManage) throw new EsignError("forbidden", "You cannot see every request")
      const requests = await store.listRequests({
        involving: scope === "all" ? undefined : caller.sub,
        status: scope === "inbox" ? ["in_progress"] : undefined,
      })
      const views = await Promise.all(requests.map((r) => view(caller, r)))
      return scope === "inbox" ? views.filter((r) => r.myTurn) : views
    },

    async getRequest(caller: Caller, id: string) {
      const request = await requestFor(caller, id)
      const [events, versions, open] = await Promise.all([
        store.listEvents(id),
        store.listVersions(id),
        store.openJobs(id),
      ])
      const current = versions.at(-1)
      const signingNow = open.find((j) => j.expiresAt > now())
      return {
        request: await view(caller, request),
        events,
        versions,
        currentDocumentId: current?.id ?? null,
        signingNow: signingNow
          ? { sub: signingNow.sub, name: request.signers.find((s) => s.id === signingNow.signerId)?.name ?? "" }
          : null,
      }
    },

    async cancelRequest(caller: Caller, id: string) {
      await requestFor(caller, id)
      if (!caller.canManage) throw new EsignError("forbidden", "Only managers can cancel requests")
      const result = await store.cancelRequest(id, {
        requestId: id,
        actorSub: caller.sub,
        type: "cancelled",
        data: null,
      })
      if (result === "conflict") throw new EsignError("conflict", "The request is not in progress")
    },

    async declineRequest(caller: Caller, id: string, reason: string | null) {
      const request = await requestFor(caller, id)
      const signer = request.signers.find((s) => s.sub === caller.sub && s.status === "pending")
      if (request.status !== "in_progress" || !signer) throw new EsignError("conflict", "There is nothing to decline")
      const why = reason?.trim() || null
      const result = await store.declineRequest(id, signer.id, why, {
        requestId: id,
        actorSub: caller.sub,
        type: "declined",
        data: { reason: why },
      })
      if (result === "conflict") throw new EsignError("conflict", "The request changed; reload it")
    },

    async retryDelivery(caller: Caller, id: string) {
      const request = await requestFor(caller, id)
      if (!caller.canManage) throw new EsignError("forbidden", "Only managers can retry the delivery")
      if (request.status !== "completed" || request.delivery?.status !== "failed")
        throw new EsignError("conflict", "Nothing to retry")
      await deliver(id, true)
      return (await store.getRequest(id))?.delivery ?? null
    },

    /** Starts a signature: a job and its single-use ticket for the agent. */
    async createJob(caller: Caller, requestId: string, placement?: PlacementInput) {
      const request = await requestFor(caller, requestId)
      const signer = turnOf(request).find((s) => s.sub === caller.sub)
      if (!signer) throw new EsignError("forbidden", "It is not your turn to sign")
      for (const job of await store.openJobs(requestId)) {
        if (job.expiresAt < now()) await store.transitionJob(job.id, ["pending", "prepared"], { status: "expired" })
        else if (job.sub === caller.sub)
          await store.transitionJob(job.id, ["pending", "prepared"], { status: "cancelled" })
        else
          throw new EsignError(
            "conflict",
            `${request.signers.find((s) => s.id === job.signerId)?.name ?? "Someone"} is signing right now`
          )
      }
      const current = await store.latestDocument(requestId)
      if (!current) throw new EsignError("not_found", "Document not found")
      let where = signer.placement
      if (placement) {
        where = validatePlacement(placement, current.pages)
        await store.updateSigner(signer.id, { placement: where })
      }
      const ticket = randomBytes(32).toString("base64url")
      const expiresAt = new Date(now().getTime() + jobTtlMs)
      const job = await store.createJob({
        ticketHash: sha256Hex(ticket),
        requestId,
        signerId: signer.id,
        sub: caller.sub,
        baseVersion: current.version,
        placement: where,
        expiresAt,
      })
      return { jobId: job.id, ticket, expiresAt }
    },

    async jobStatus(caller: Caller, jobId: string) {
      const job = await store.getJob(jobId)
      if (!job || job.sub !== caller.sub) throw new EsignError("not_found", "Signature not found")
      const expired = (job.status === "pending" || job.status === "prepared") && job.expiresAt < now()
      return {
        status: expired ? ("expired" as const) : job.status,
        errorCode: job.errorCode,
        errorMessage: job.errorMessage,
        expiresAt: job.expiresAt,
        /** The agent opened the job: the popup reached it. */
        seen: job.seenAt !== null,
      }
    },

    async cancelJob(caller: Caller, jobId: string) {
      const job = await store.getJob(jobId)
      if (!job || job.sub !== caller.sub) throw new EsignError("not_found", "Signature not found")
      await store.transitionJob(job.id, ["pending", "prepared"], { status: "cancelled" })
    },

    // ── The agent's side, authenticated by the ticket ──────────────────────────────────────────────────────────

    async agentJob(ticket: string) {
      const job = await resolveTicket(ticket, ["pending", "prepared"])
      const { request, signer, current } = await jobContext(job)
      if (!job.seenAt) await store.transitionJob(job.id, ["pending", "prepared"], { seenAt: now() })
      return {
        id: job.id,
        status: job.status,
        expiresAt: job.expiresAt,
        document: { title: request.title, fileName: current.fileName, pages: current.pages },
        signer: { name: signer.name, role: signer.role },
        placement: { page: job.placement.page },
        requestedBy: await profileName(request.createdBySub),
      }
    },

    async agentPrepare(ticket: string, certificateB64: string, chainB64: string[] = []) {
      const job = await resolveTicket(ticket, ["pending", "prepared"])
      const { request, signer, current } = await jobContext(job)
      let cert: X509Certificate
      try {
        cert = new X509Certificate(Buffer.from(certificateB64, "base64"))
      } catch {
        throw new EsignError("certificate_invalid", "The card's certificate cannot be read")
      }
      const at = now()
      if (at < new Date(cert.validFrom) || at > new Date(cert.validTo))
        throw new EsignError("certificate_invalid", "The CIE certificate is expired")
      const trust = (options.trust ?? cieChain)(cert, at)
      if (!trust.trusted && !options.allowTestCertificates)
        throw new EsignError("certificate_invalid", "This certificate was not issued for a CIE")
      const identity = identityOf(cert)
      if (!identity.fiscalCode && !options.allowTestCertificates)
        throw new EsignError("certificate_invalid", "The certificate carries no fiscal code")
      const revocation = await revocationOf(cert, trust.issuer)
      const profile = await store.getProfile(signer.sub)
      if (profile?.fiscalCode && identity.fiscalCode && profile.fiscalCode !== identity.fiscalCode)
        throw new EsignError("signer_mismatch", `This CIE does not belong to ${signer.name}`)

      const pdf = await info(current.sha256, current.content)
      const used = new Set(pdf.fieldNames)
      let fieldName = `Firma ${identity.name}`
      for (let i = 2; used.has(fieldName); i++) fieldName = `Firma ${identity.name} ${i}`
      const chain = trust.trusted ? trust.chain : chainB64.slice(0, 4).map(fromB64)
      let prepared: PreparedSignature
      try {
        prepared = await prepareSignature(current.content, new Uint8Array(cert.raw), {
          placement: job.placement,
          fieldName,
          signerName: identity.name,
          reason: signer.role ? `${titleCase(signer.role)} - ${request.title}` : request.title,
          signingTime: at,
          appearance: {
            lines: [
              { text: "Firmato digitalmente da", muted: true },
              { text: identity.name, bold: true },
              ...(signer.role ? [{ text: titleCase(signer.role) }] : []),
              { text: `${formatRomeDate(at)} · CIE`, muted: true },
            ],
          },
        })
      } catch (error) {
        if (error instanceof PdfError || error instanceof SignatureError)
          throw new EsignError(error instanceof SignatureError ? "certificate_invalid" : "pdf_invalid", error.message)
        throw error
      }
      const ok = await store.transitionJob(job.id, ["pending", "prepared"], {
        status: "prepared",
        errorCode: null,
        errorMessage: null,
        preparedPdf: prepared.placeholder.pdf,
        prepared: {
          byteRange: prepared.placeholder.byteRange,
          contentsOffset: prepared.placeholder.contentsOffset,
          contentsHexLength: prepared.placeholder.contentsHexLength,
          signedAttrs: b64(prepared.signedAttrs),
          toBeSigned: b64(prepared.toBeSigned),
          certificate: b64(prepared.certificate),
          chain: chain.map(b64),
          signingTime: at.toISOString(),
          revocation,
        },
      })
      if (!ok) throw new EsignError("conflict", "The signature changed state; start again")
      return { toBeSigned: b64(prepared.toBeSigned), algorithm: "RSASSA-PKCS1-v1_5-SHA256" as const }
    },

    async agentComplete(ticket: string, signatureB64: string) {
      const job = await resolveTicket(ticket, ["prepared"])
      const { request, signer, current } = await jobContext(job)
      const state = job.prepared
      const pdf = await store.getPreparedPdf(job.id)
      if (!state || !pdf) throw new EsignError("conflict", "The signature is not ready")
      const prepared: PreparedSignature = {
        placeholder: {
          pdf,
          byteRange: state.byteRange,
          contentsOffset: state.contentsOffset,
          contentsHexLength: state.contentsHexLength,
        },
        signedAttrs: fromB64(state.signedAttrs),
        toBeSigned: fromB64(state.toBeSigned),
        certificate: fromB64(state.certificate),
      }
      let signed: Uint8Array
      try {
        signed = finalizeSignature(prepared, fromB64(signatureB64), state.chain.map(fromB64))
      } catch (error) {
        if (error instanceof SignatureError) {
          await store.transitionJob(job.id, ["prepared"], {
            errorCode: "signature_invalid",
            errorMessage: error.message,
          })
          throw new EsignError("signature_invalid", "The card's signature does not match. Try again.")
        }
        throw error
      }
      const sha256 = sha256Hex(signed)
      const check = await info(sha256, signed)
      const last = check.signatures.at(-1)
      if (!last?.intact || !last.verified || !last.coversWholeDocument)
        throw new EsignError("signature_invalid", "The signed document failed verification")

      const identity = identityOf(new X509Certificate(Buffer.from(prepared.certificate)))
      return commitSigned({
        request,
        signer,
        current,
        job,
        signed,
        sha256,
        identity,
        method: "agent",
        revocation: state.revocation ?? null,
      })
    },

    /**
     * The fallback when the agent can't run: the signer signs the current version with the official CIE app
     * (Software CIE, CieSign) and uploads the result. It must be the current version byte for byte plus exactly one
     * new signature covering the whole file, made with a CIE belonging to the signer.
     */
    async uploadSigned(caller: Caller, requestId: string, bytes: Uint8Array) {
      const request = await requestFor(caller, requestId)
      const signer = turnOf(request).find((s) => s.sub === caller.sub)
      if (!signer) throw new EsignError("forbidden", "It is not your turn to sign")
      for (const job of await store.openJobs(requestId))
        if (job.sub !== caller.sub && job.expiresAt > now())
          throw new EsignError("conflict", "Someone is signing right now. Try again in a few minutes.")
      const current = await store.latestDocument(requestId)
      if (!current) throw new EsignError("not_found", "Document not found")
      if (bytes.length > MAX_PDF_BYTES) throw new EsignError("pdf_invalid", "The PDF is larger than 30 MB")
      const mismatch =
        "This file isn't the current version with your signature added. Download the PDF again, sign it, then upload it."
      if (
        bytes.length <= current.size ||
        !Buffer.from(bytes.subarray(0, current.size)).equals(Buffer.from(current.content))
      )
        throw new EsignError("pdf_invalid", mismatch)
      const sha256 = sha256Hex(bytes)
      let check: PdfInfo
      let before: PdfInfo
      try {
        ;[check, before] = await Promise.all([info(sha256, bytes), info(current.sha256, current.content)])
      } catch (error) {
        if (error instanceof PdfError) throw new EsignError("pdf_invalid", error.message)
        throw error
      }
      const last = check.signatures.at(-1)
      if (check.signatures.length !== before.signatures.length + 1 || !last)
        throw new EsignError("pdf_invalid", "The file must add exactly one signature")
      if (!last.intact || !last.verified || !last.coversWholeDocument || !check.lastCertificate)
        throw new EsignError("signature_invalid", "The signature in the file is not valid")
      const cert = check.lastCertificate
      const at = now()
      if (at < new Date(cert.validFrom) || at > new Date(cert.validTo))
        throw new EsignError("certificate_invalid", "The CIE certificate is expired")
      const uploadTrust = (options.trust ?? cieChain)(cert, at)
      if (!uploadTrust.trusted && !options.allowTestCertificates)
        throw new EsignError("certificate_invalid", "The file was not signed with a CIE")
      const identity = identityOf(cert)
      if (!identity.fiscalCode && !options.allowTestCertificates)
        throw new EsignError("certificate_invalid", "The certificate carries no fiscal code")
      const uploadRevocation = await revocationOf(cert, uploadTrust.issuer)
      const profile = await store.getProfile(signer.sub)
      if (profile?.fiscalCode && identity.fiscalCode && profile.fiscalCode !== identity.fiscalCode)
        throw new EsignError("signer_mismatch", `This CIE does not belong to ${signer.name}`)

      // A one-off job carries the upload through the same atomic commit as the agent's signatures.
      for (const job of await store.openJobs(requestId))
        await store.transitionJob(job.id, ["pending", "prepared"], { status: "cancelled" })
      const job = await store.createJob({
        ticketHash: sha256Hex(randomBytes(32)),
        requestId,
        signerId: signer.id,
        sub: caller.sub,
        baseVersion: current.version,
        placement: signer.placement,
        expiresAt: new Date(at.getTime() + 60_000),
      })
      await store.transitionJob(job.id, ["pending"], { status: "prepared" })
      return commitSigned({
        request,
        signer,
        current,
        job,
        signed: bytes,
        sha256,
        identity,
        method: "upload",
        revocation: uploadRevocation,
      })
    },

    async agentFail(ticket: string, code: string, message: string | null) {
      const job = await resolveTicket(ticket, ["pending", "prepared"])
      const safeCode = code.replace(/[^a-z_]/g, "").slice(0, 40) || "unknown"
      if (safeCode === "cancelled") await store.transitionJob(job.id, ["pending", "prepared"], { status: "cancelled" })
      else
        await store.transitionJob(job.id, ["pending", "prepared"], {
          errorCode: safeCode,
          errorMessage: message?.slice(0, 300) ?? null,
        })
      return { status: safeCode === "cancelled" ? "cancelled" : job.status }
    },

    /** Periodic cleanup: expired jobs, their prepared PDFs and abandoned uploads. */
    async sweep() {
      await store.sweepJobs(now())
      for (const id of await store.pendingDeliveries(new Date(now().getTime() - DELIVERY_CLAIM_MS)))
        await deliver(id).catch((error) => logger.error({ error, requestId: id }, "[ESIGN] resumed delivery failed"))
      const removed = await store.deleteStaleStaged(new Date(now().getTime() - STAGED_TTL_MS))
      if (removed) logger.info({ removed }, "[ESIGN] removed abandoned uploads")
    },

    deliver,
  }
}

export type EsignService = ReturnType<typeof createEsignService>
export type { PlacementInput }
