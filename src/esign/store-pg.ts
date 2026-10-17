import { and, asc, desc, eq, exists, inArray, isNull, lt, or, sql } from "drizzle-orm"
import type { DB as Database } from "@/db"
import { schema } from "@/db/schema/esign"
import type {
  DocumentMeta,
  DocumentRecord,
  EsignStore,
  Job,
  Profile,
  RequestEvent,
  Signer,
  SigningRequest,
} from "./store"

const { profiles, requests, documents, signers, jobs, events } = schema

type Db = typeof Database

const documentMeta = {
  id: documents.id,
  requestId: documents.requestId,
  version: documents.version,
  fileName: documents.fileName,
  sha256: documents.sha256,
  size: documents.size,
  pages: documents.pages,
  source: documents.source,
  createdBySub: documents.createdBySub,
  createdAt: documents.createdAt,
}

const jobColumns = {
  id: jobs.id,
  ticketHash: jobs.ticketHash,
  requestId: jobs.requestId,
  signerId: jobs.signerId,
  sub: jobs.sub,
  status: jobs.status,
  baseVersion: jobs.baseVersion,
  placement: jobs.placement,
  expiresAt: jobs.expiresAt,
  prepared: jobs.prepared,
  errorCode: jobs.errorCode,
  errorMessage: jobs.errorMessage,
  seenAt: jobs.seenAt,
  createdAt: jobs.createdAt,
  completedAt: jobs.completedAt,
}

const toProfile = (row: typeof profiles.$inferSelect): Profile => ({
  sub: row.sub,
  name: row.name,
  email: row.email,
  fiscalCode: row.fiscalCode,
  certificateSubject: row.certificateSubject,
})

const toSigner = (row: typeof signers.$inferSelect): Signer => ({
  id: row.id,
  requestId: row.requestId,
  position: row.position,
  sub: row.sub,
  name: row.name,
  role: row.role,
  placement: row.placement,
  status: row.status,
  signedAt: row.signedAt,
  version: row.version,
  fiscalCode: row.fiscalCode,
  certificateSubject: row.certificateSubject,
  certificateIssuer: row.certificateIssuer,
  declineReason: row.declineReason,
})

/** The e-signing store over the backend's Postgres. */
export function createPgStore(db: Db): EsignStore {
  async function attachSigners(rows: (typeof requests.$inferSelect)[]): Promise<SigningRequest[]> {
    if (rows.length === 0) return []
    const all = await db
      .select()
      .from(signers)
      .where(
        inArray(
          signers.requestId,
          rows.map((r) => r.id)
        )
      )
      .orderBy(asc(signers.position))
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      status: r.status,
      ordered: r.ordered,
      output: r.output,
      email: r.email,
      delivery: r.delivery,
      createdBySub: r.createdBySub,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      completedAt: r.completedAt,
      cancelledAt: r.cancelledAt,
      signers: all.filter((s) => s.requestId === r.id).map(toSigner),
    }))
  }

  return {
    async upsertProfile({ sub, name, email }) {
      const [row] = await db
        .insert(profiles)
        .values({ sub, name, email })
        .onConflictDoUpdate({ target: profiles.sub, set: { name, email } })
        .returning()
      return toProfile(row)
    },
    async getProfile(sub) {
      const [row] = await db.select().from(profiles).where(eq(profiles.sub, sub)).limit(1)
      return row ? toProfile(row) : null
    },
    async listProfiles() {
      return (await db.select().from(profiles).orderBy(asc(profiles.name))).map(toProfile)
    },
    async setProfileIdentity(sub, identity) {
      await db
        .update(profiles)
        .set({ fiscalCode: identity?.fiscalCode ?? null, certificateSubject: identity?.certificateSubject ?? null })
        .where(eq(profiles.sub, sub))
    },

    async insertDocument(doc) {
      const [row] = await db.insert(documents).values(doc).returning(documentMeta)
      return row as DocumentMeta
    },
    async getDocument(id) {
      const [row] = await db.select().from(documents).where(eq(documents.id, id)).limit(1)
      return (row as DocumentRecord | undefined) ?? null
    },
    async getDocumentMeta(id) {
      const [row] = await db.select(documentMeta).from(documents).where(eq(documents.id, id)).limit(1)
      return (row as DocumentMeta | undefined) ?? null
    },
    async latestDocument(requestId) {
      const [row] = await db
        .select()
        .from(documents)
        .where(eq(documents.requestId, requestId))
        .orderBy(desc(documents.version))
        .limit(1)
      return (row as DocumentRecord | undefined) ?? null
    },
    async listVersions(requestId) {
      return (await db
        .select(documentMeta)
        .from(documents)
        .where(eq(documents.requestId, requestId))
        .orderBy(asc(documents.version))) as DocumentMeta[]
    },
    async deleteStaleStaged(before) {
      const rows = await db
        .delete(documents)
        .where(and(isNull(documents.requestId), lt(documents.createdAt, before)))
        .returning({ id: documents.id })
      return rows.length
    },

    async createRequest(input) {
      const id = await db.transaction(async (tx) => {
        const [request] = await tx
          .insert(requests)
          .values({
            title: input.title,
            ordered: input.ordered,
            output: input.output,
            email: input.email,
            createdBySub: input.createdBySub,
          })
          .returning({ id: requests.id })
        const attached = await tx
          .update(documents)
          .set({ requestId: request.id, version: 0 })
          .where(and(eq(documents.id, input.documentId), isNull(documents.requestId)))
          .returning({ id: documents.id })
        if (attached.length !== 1) throw new Error("document not staged")
        await tx.insert(signers).values(
          input.signers.map((s, position) => ({
            requestId: request.id,
            position,
            sub: s.sub,
            name: s.name,
            role: s.role,
            placement: s.placement,
          }))
        )
        return request.id
      })
      const [created] = await attachSigners(await db.select().from(requests).where(eq(requests.id, id)))
      return created
    },
    async getRequest(id) {
      const rows = await db.select().from(requests).where(eq(requests.id, id)).limit(1)
      return (await attachSigners(rows))[0] ?? null
    },
    async listRequests(filter) {
      const conditions = []
      if (filter.involving)
        conditions.push(
          or(
            eq(requests.createdBySub, filter.involving),
            exists(
              db
                .select({ one: sql`1` })
                .from(signers)
                .where(and(eq(signers.requestId, requests.id), eq(signers.sub, filter.involving)))
            )
          )
        )
      if (filter.status) conditions.push(inArray(requests.status, filter.status))
      const rows = await db
        .select()
        .from(requests)
        .where(and(...conditions))
        .orderBy(desc(requests.createdAt))
        .limit(filter.limit ?? 200)
      return attachSigners(rows)
    },
    async updateRequest(id, patch) {
      await db.update(requests).set(patch).where(eq(requests.id, id))
    },
    async updateSigner(id, patch) {
      await db.update(signers).set(patch).where(eq(signers.id, id))
    },

    async addEvent(event) {
      await db.insert(events).values(event)
    },
    async listEvents(requestId) {
      return (await db
        .select()
        .from(events)
        .where(eq(events.requestId, requestId))
        .orderBy(asc(events.id))) as RequestEvent[]
    },

    async createJob(job) {
      const [row] = await db.insert(jobs).values(job).returning(jobColumns)
      return row as Job
    },
    async getJob(id) {
      const [row] = await db.select(jobColumns).from(jobs).where(eq(jobs.id, id)).limit(1)
      return (row as Job | undefined) ?? null
    },
    async getJobByTicketHash(hash) {
      const [row] = await db.select(jobColumns).from(jobs).where(eq(jobs.ticketHash, hash)).limit(1)
      return (row as Job | undefined) ?? null
    },
    async getPreparedPdf(jobId) {
      const [row] = await db.select({ pdf: jobs.preparedPdf }).from(jobs).where(eq(jobs.id, jobId)).limit(1)
      return row?.pdf ?? null
    },
    async openJobs(requestId) {
      return (await db
        .select(jobColumns)
        .from(jobs)
        .where(and(eq(jobs.requestId, requestId), inArray(jobs.status, ["pending", "prepared"])))) as Job[]
    },
    async transitionJob(id, from, patch) {
      const rows = await db
        .update(jobs)
        .set(patch)
        .where(and(eq(jobs.id, id), inArray(jobs.status, from)))
        .returning({ id: jobs.id })
      return rows.length === 1
    },
    async commitSignature(commit) {
      return db.transaction(async (tx) => {
        // Serializes signatures on one request.
        const [request] = await tx.select().from(requests).where(eq(requests.id, commit.requestId)).for("update")
        if (!request || request.status !== "in_progress") return "conflict" as const
        const [current] = await tx
          .select({ version: documents.version })
          .from(documents)
          .where(eq(documents.requestId, commit.requestId))
          .orderBy(desc(documents.version))
          .limit(1)
        if (!current || current.version !== commit.baseVersion) return "conflict" as const
        const done = await tx
          .update(jobs)
          .set({ status: "completed", completedAt: new Date(), preparedPdf: null })
          .where(and(eq(jobs.id, commit.jobId), eq(jobs.status, "prepared")))
          .returning({ id: jobs.id })
        if (done.length !== 1) return "conflict" as const
        await tx.insert(documents).values(commit.document)
        await tx
          .update(signers)
          .set({
            status: "signed",
            signedAt: new Date(),
            version: commit.document.version,
            fiscalCode: commit.signer.fiscalCode,
            certificateSubject: commit.signer.certificateSubject,
            certificateIssuer: commit.signer.certificateIssuer,
          })
          .where(eq(signers.id, commit.signer.id))
        if (commit.complete)
          await tx
            .update(requests)
            .set({
              status: "completed",
              completedAt: new Date(),
              delivery: { status: "pending", driveItem: null, emailedTo: [], error: null, attemptedAt: null },
            })
            .where(eq(requests.id, commit.requestId))
        await tx.insert(events).values(commit.event)
        return "ok" as const
      })
    },
    async sweepJobs(now) {
      await db
        .update(jobs)
        .set({ status: "expired", preparedPdf: null })
        .where(and(inArray(jobs.status, ["pending", "prepared"]), lt(jobs.expiresAt, now)))
      await db
        .update(jobs)
        .set({ preparedPdf: null })
        .where(
          and(
            inArray(jobs.status, ["completed", "failed", "cancelled", "expired"]),
            sql`${jobs.preparedPdf} IS NOT NULL`
          )
        )
    },
  }
}
