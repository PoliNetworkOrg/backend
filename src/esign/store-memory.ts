import { randomUUID } from "node:crypto"
import type {
  DocumentMeta,
  DocumentRecord,
  EsignStore,
  Job,
  NewDocument,
  NewEvent,
  NewJob,
  NewRequest,
  Profile,
  RequestEvent,
  RequestFilter,
  SignatureCommit,
  Signer,
  SigningRequest,
} from "./store"

type StoredRequest = Omit<SigningRequest, "signers">

const meta = ({ content: _, ...rest }: DocumentRecord): DocumentMeta => rest

/** An in-memory store for tests. */
export function createMemoryStore(): EsignStore {
  const profiles = new Map<string, Profile>()
  const documents = new Map<string, DocumentRecord>()
  const requests = new Map<string, StoredRequest>()
  const signers = new Map<string, Signer>()
  const jobs = new Map<string, Job>()
  const preparedPdfs = new Map<string, Uint8Array>()
  const events: RequestEvent[] = []

  const withSigners = (r: StoredRequest): SigningRequest => ({
    ...r,
    signers: [...signers.values()].filter((s) => s.requestId === r.id).sort((a, b) => a.position - b.position),
  })
  /** Mirrors `turnOf`: a pending signer, and in an ordered request the first pending one. */
  const awaits = (r: SigningRequest, sub: string) => {
    if (r.status !== "in_progress") return false
    const pending = r.signers.filter((s) => s.status === "pending")
    return (r.ordered ? pending.slice(0, 1) : pending).some((s) => s.sub === sub)
  }
  const insertDocument = (doc: NewDocument): DocumentRecord => {
    const record = { ...doc, id: randomUUID(), createdAt: new Date() }
    documents.set(record.id, record)
    return record
  }
  const latest = (requestId: string) =>
    [...documents.values()].filter((d) => d.requestId === requestId).sort((a, b) => b.version - a.version)[0] ?? null

  return {
    async upsertProfile({ sub, name, email }) {
      const current = profiles.get(sub)
      const profile = { fiscalCode: null, certificateSubject: null, ...current, sub, name, email }
      profiles.set(sub, profile)
      return profile
    },
    async getProfile(sub) {
      return profiles.get(sub) ?? null
    },
    async listProfiles() {
      return [...profiles.values()].sort((a, b) => a.name.localeCompare(b.name))
    },
    async setProfileIdentity(sub, identity) {
      const profile = profiles.get(sub)
      if (!profile) return
      profiles.set(sub, {
        ...profile,
        fiscalCode: identity?.fiscalCode ?? null,
        certificateSubject: identity?.certificateSubject ?? null,
      })
    },

    async insertDocument(doc) {
      return meta(insertDocument(doc))
    },
    async getDocument(id) {
      return documents.get(id) ?? null
    },
    async getDocumentMeta(id) {
      const doc = documents.get(id)
      return doc ? meta(doc) : null
    },
    async latestDocument(requestId) {
      return latest(requestId)
    },
    async listVersions(requestId) {
      return [...documents.values()]
        .filter((d) => d.requestId === requestId)
        .sort((a, b) => a.version - b.version)
        .map(meta)
    },
    async deleteStaleStaged(before) {
      let count = 0
      for (const [id, d] of documents)
        if (d.requestId === null && d.createdAt < before) {
          documents.delete(id)
          count++
        }
      return count
    },

    async createRequest(input: NewRequest) {
      const doc = documents.get(input.documentId)
      if (!doc || doc.requestId !== null) throw new Error("document not staged")
      const id = randomUUID()
      const now = new Date()
      requests.set(id, {
        id,
        title: input.title,
        status: "in_progress",
        ordered: input.ordered,
        output: input.output,
        email: input.email,
        delivery: null,
        createdBySub: input.createdBySub,
        createdAt: now,
        updatedAt: null,
        completedAt: null,
        cancelledAt: null,
      })
      documents.set(doc.id, { ...doc, requestId: id, version: 0 })
      input.signers.forEach((s, position) => {
        const signer: Signer = {
          id: randomUUID(),
          requestId: id,
          position,
          sub: s.sub,
          name: s.name,
          role: s.role,
          places: s.places,
          signaturesDone: 0,
          status: "pending",
          signedAt: null,
          version: null,
          fiscalCode: null,
          certificateSubject: null,
          certificateIssuer: null,
          declineReason: null,
        }
        signers.set(signer.id, signer)
      })
      return withSigners(requests.get(id) as StoredRequest)
    },
    async getRequest(id) {
      const r = requests.get(id)
      return r ? withSigners(r) : null
    },
    async listRequests(filter: RequestFilter) {
      return [...requests.values()]
        .map(withSigners)
        .filter(
          (r) =>
            !filter.involving ||
            r.createdBySub === filter.involving ||
            r.signers.some((s) => s.sub === filter.involving)
        )
        .filter((r) => !filter.awaiting || awaits(r, filter.awaiting))
        .filter((r) => !filter.status || filter.status.includes(r.status))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, filter.limit ?? 200)
    },
    async updateRequest(id, patch) {
      const r = requests.get(id)
      if (r) requests.set(id, { ...r, ...patch, updatedAt: new Date() })
    },
    async updateSigner(id, patch) {
      const s = signers.get(id)
      if (s) signers.set(id, { ...s, ...patch })
    },

    async addEvent(event: NewEvent) {
      events.push({ ...event, id: events.length + 1, at: new Date() })
    },
    async listEvents(requestId) {
      return events.filter((e) => e.requestId === requestId)
    },

    async createJob(job: NewJob) {
      const record: Job = {
        ...job,
        id: randomUUID(),
        status: "pending",
        prepared: null,
        errorCode: null,
        errorMessage: null,
        seenAt: null,
        createdAt: new Date(),
        completedAt: null,
      }
      jobs.set(record.id, record)
      return record
    },
    async getJob(id) {
      return jobs.get(id) ?? null
    },
    async getJobByTicketHash(hash) {
      return [...jobs.values()].find((j) => j.ticketHash === hash) ?? null
    },
    async getPreparedPdf(jobId) {
      return preparedPdfs.get(jobId) ?? null
    },
    async openJobs(requestId) {
      return [...jobs.values()].filter(
        (j) => j.requestId === requestId && (j.status === "pending" || j.status === "prepared")
      )
    },
    async transitionJob(id, from, { preparedPdf, ...patch }) {
      const job = jobs.get(id)
      if (!job || !from.includes(job.status)) return false
      jobs.set(id, { ...job, ...patch })
      if (preparedPdf !== undefined) {
        if (preparedPdf) preparedPdfs.set(id, preparedPdf)
        else preparedPdfs.delete(id)
      }
      return true
    },
    async cancelRequest(id, event) {
      const request = requests.get(id)
      if (!request || request.status !== "in_progress") return "conflict"
      for (const [jobId, job] of jobs)
        if (job.requestId === id && (job.status === "pending" || job.status === "prepared"))
          jobs.set(jobId, { ...job, status: "cancelled" })
      requests.set(id, { ...request, status: "cancelled", cancelledAt: new Date() })
      events.push({ ...event, id: events.length + 1, at: new Date() })
      return "ok"
    },
    async declineRequest(id, signerId, reason, event) {
      const request = requests.get(id)
      const signer = signers.get(signerId)
      if (
        !request ||
        request.status !== "in_progress" ||
        !signer ||
        signer.requestId !== id ||
        signer.status !== "pending"
      )
        return "conflict"
      signers.set(signerId, { ...signer, status: "declined", declineReason: reason })
      for (const [jobId, job] of jobs)
        if (job.requestId === id && (job.status === "pending" || job.status === "prepared"))
          jobs.set(jobId, { ...job, status: "cancelled" })
      requests.set(id, { ...request, status: "declined" })
      events.push({ ...event, id: events.length + 1, at: new Date() })
      return "ok"
    },
    async claimDelivery(id, at, staleBefore, retry) {
      const request = requests.get(id)
      const delivery = request?.delivery
      if (!request || request.status !== "completed" || !delivery) return false
      const claimable = retry
        ? delivery.status === "failed"
        : delivery.status === "pending" && (!delivery.attemptedAt || new Date(delivery.attemptedAt) < staleBefore)
      if (!claimable) return false
      requests.set(id, { ...request, delivery: { ...delivery, status: "pending", attemptedAt: at.toISOString() } })
      return true
    },
    async pendingDeliveries(staleBefore) {
      return [...requests.values()]
        .filter(
          (r) =>
            r.status === "completed" &&
            r.delivery?.status === "pending" &&
            (!r.delivery.attemptedAt || new Date(r.delivery.attemptedAt) < staleBefore)
        )
        .map((r) => r.id)
    },
    async commitSignature(commit: SignatureCommit) {
      const profile = profiles.get(commit.identity.sub)
      if (profile?.fiscalCode && commit.identity.fiscalCode !== profile.fiscalCode) return "mismatch"
      const job = jobs.get(commit.jobId)
      const current = latest(commit.requestId)
      const request = requests.get(commit.requestId)
      if (!job || job.status !== "prepared" || !current || current.version !== commit.baseVersion || !request)
        return "conflict"
      if (request.status !== "in_progress") return "conflict"
      const doc = insertDocument(commit.document)
      const signer = signers.get(commit.signer.id)
      if (signer)
        signers.set(
          signer.id,
          commit.final
            ? {
                ...signer,
                status: "signed",
                signedAt: new Date(),
                version: doc.version,
                signaturesDone: signer.signaturesDone + 1,
                fiscalCode: commit.signer.fiscalCode,
                certificateSubject: commit.signer.certificateSubject,
                certificateIssuer: commit.signer.certificateIssuer,
              }
            : { ...signer, signaturesDone: signer.signaturesDone + 1 }
        )
      jobs.set(
        job.id,
        commit.final
          ? { ...job, status: "completed", completedAt: new Date() }
          : { ...job, status: "pending", step: job.step + 1, baseVersion: doc.version, prepared: null }
      )
      preparedPdfs.delete(job.id)
      if (commit.complete)
        requests.set(request.id, {
          ...request,
          status: "completed",
          completedAt: new Date(),
          delivery: { status: "pending", driveItem: null, emailedTo: [], error: null, attemptedAt: null },
        })
      if (commit.final) events.push({ ...commit.event, id: events.length + 1, at: new Date() })
      if (commit.complete)
        events.push({
          requestId: commit.requestId,
          actorSub: null,
          type: "completed",
          data: null,
          id: events.length + 1,
          at: new Date(),
        })
      if (profile && !profile.fiscalCode && commit.identity.fiscalCode)
        profiles.set(profile.sub, {
          ...profile,
          fiscalCode: commit.identity.fiscalCode,
          certificateSubject: commit.identity.certificateSubject,
        })
      return "ok"
    },
    async sweepJobs(now) {
      for (const [id, job] of jobs) {
        if ((job.status === "pending" || job.status === "prepared") && job.expiresAt < now)
          jobs.set(id, { ...job, status: "expired" })
        if (job.status !== "pending" && job.status !== "prepared") preparedPdfs.delete(id)
      }
    },
  }
}
