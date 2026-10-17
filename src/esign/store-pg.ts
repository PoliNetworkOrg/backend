import { and, asc, desc, eq, exists, inArray, isNull, lt, notExists, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"
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

const { profiles, requests, documents, signers, jobs, events, driveAccess } = schema

/**
 * `delivery` as a JSON object. drizzle's bun-sql driver stores jsonb values as a JSON string scalar; `#>> '{}'` then
 * `::jsonb` reads both that and a plain object, so the operators below work either way.
 */
const delivery = sql`((${requests.delivery} #>> '{}')::jsonb)`

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
  places: jobs.places,
  step: jobs.step,
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
  places: row.places,
  signaturesDone: row.signaturesDone,
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
      drives: r.drives,
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
            drives: input.drives,
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
            places: s.places,
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
      if (filter.awaiting) {
        // Mirrors `turnOf`: a pending signer, and in an ordered request the first pending one.
        const earlier = alias(signers, "earlier")
        conditions.push(
          eq(requests.status, "in_progress"),
          exists(
            db
              .select({ one: sql`1` })
              .from(signers)
              .where(
                and(
                  eq(signers.requestId, requests.id),
                  eq(signers.sub, filter.awaiting),
                  eq(signers.status, "pending"),
                  or(
                    eq(requests.ordered, false),
                    notExists(
                      db
                        .select({ one: sql`1` })
                        .from(earlier)
                        .where(
                          and(
                            eq(earlier.requestId, requests.id),
                            eq(earlier.status, "pending"),
                            lt(earlier.position, signers.position)
                          )
                        )
                    )
                  )
                )
              )
          )
        )
      }
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

    async listDriveAccess() {
      const rows = await db.select().from(driveAccess).orderBy(asc(driveAccess.driveId))
      return rows.map((row) => ({
        driveId: row.driveId,
        request: { roles: row.requestRoles, permissions: row.requestPermissions },
        sign: { roles: row.signRoles, permissions: row.signPermissions },
        updatedBySub: row.updatedBySub,
        updatedAt: row.updatedAt,
      }))
    },
    async setDriveAccess(access) {
      const values = {
        requestRoles: access.request.roles,
        requestPermissions: access.request.permissions,
        signRoles: access.sign.roles,
        signPermissions: access.sign.permissions,
        updatedBySub: access.updatedBySub,
      }
      await db
        .insert(driveAccess)
        .values({ driveId: access.driveId, ...values })
        .onConflictDoUpdate({ target: driveAccess.driveId, set: values })
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
    async cancelRequest(id, event) {
      return db.transaction(async (tx) => {
        const [request] = await tx.select().from(requests).where(eq(requests.id, id)).for("update")
        if (!request || request.status !== "in_progress") return "conflict" as const
        await tx
          .update(jobs)
          .set({ status: "cancelled", preparedPdf: null })
          .where(and(eq(jobs.requestId, id), inArray(jobs.status, ["pending", "prepared"])))
        await tx.update(requests).set({ status: "cancelled", cancelledAt: new Date() }).where(eq(requests.id, id))
        await tx.insert(events).values(event)
        return "ok" as const
      })
    },
    async declineRequest(id, signerId, reason, event) {
      return db.transaction(async (tx) => {
        const [request] = await tx.select().from(requests).where(eq(requests.id, id)).for("update")
        if (!request || request.status !== "in_progress") return "conflict" as const
        const declined = await tx
          .update(signers)
          .set({ status: "declined", declineReason: reason })
          .where(and(eq(signers.id, signerId), eq(signers.requestId, id), eq(signers.status, "pending")))
          .returning({ id: signers.id })
        if (declined.length !== 1) return "conflict" as const
        await tx
          .update(jobs)
          .set({ status: "cancelled", preparedPdf: null })
          .where(and(eq(jobs.requestId, id), inArray(jobs.status, ["pending", "prepared"])))
        await tx.update(requests).set({ status: "declined" }).where(eq(requests.id, id))
        await tx.insert(events).values(event)
        return "ok" as const
      })
    },
    async claimDelivery(id, at, staleBefore, retry) {
      // A claim turns the delivery pending with a fresh attempt time, so every other caller, retries included, sees an
      // active lease until it goes stale. A retry may only take a failed delivery.
      const claimable = retry
        ? sql`${delivery}->>'status' = 'failed'`
        : sql`(${delivery}->>'status' = 'pending' and (${delivery}->>'attemptedAt' is null or (${delivery}->>'attemptedAt')::timestamptz < ${staleBefore.toISOString()}::timestamptz))`
      const rows = await db
        .update(requests)
        .set({
          delivery: sql`jsonb_set(jsonb_set(${delivery}, '{status}', '"pending"'), '{attemptedAt}', to_jsonb(${at.toISOString()}::text))`,
        })
        .where(and(eq(requests.id, id), eq(requests.status, "completed"), claimable))
        .returning({ id: requests.id })
      return rows.length === 1
    },
    async pendingDeliveries(staleBefore) {
      const rows = await db
        .select({ id: requests.id })
        .from(requests)
        .where(
          and(
            eq(requests.status, "completed"),
            sql`${delivery}->>'status' = 'pending'`,
            sql`(${delivery}->>'attemptedAt' is null or (${delivery}->>'attemptedAt')::timestamptz < ${staleBefore.toISOString()}::timestamptz)`
          )
        )
        .limit(20)
      return rows.map((r) => r.id)
    },
    async commitSignature(commit) {
      return db.transaction(async (tx) => {
        // Serializes signatures on one request.
        const [request] = await tx.select().from(requests).where(eq(requests.id, commit.requestId)).for("update")
        if (!request || request.status !== "in_progress") return "conflict" as const
        // The signer's bound CIE: locked, compared and bound on first use within this transaction.
        const [profile] = await tx.select().from(profiles).where(eq(profiles.sub, commit.identity.sub)).for("update")
        const { fiscalCode, certificateSubject } = commit.identity
        if (profile?.fiscalCode && fiscalCode !== profile.fiscalCode) return "mismatch" as const
        const [current] = await tx
          .select({ version: documents.version })
          .from(documents)
          .where(eq(documents.requestId, commit.requestId))
          .orderBy(desc(documents.version))
          .limit(1)
        if (!current || current.version !== commit.baseVersion) return "conflict" as const
        const done = await tx
          .update(jobs)
          .set(
            commit.final
              ? { status: "completed", completedAt: new Date(), preparedPdf: null }
              : {
                  status: "pending",
                  step: sql`${jobs.step} + 1`,
                  baseVersion: commit.document.version,
                  prepared: null,
                  preparedPdf: null,
                }
          )
          .where(and(eq(jobs.id, commit.jobId), eq(jobs.status, "prepared")))
          .returning({ id: jobs.id })
        if (done.length !== 1) return "conflict" as const
        await tx.insert(documents).values(commit.document)
        await tx
          .update(signers)
          .set(
            commit.final
              ? {
                  status: "signed",
                  signedAt: new Date(),
                  version: commit.document.version,
                  signaturesDone: sql`${signers.signaturesDone} + 1`,
                  fiscalCode: commit.signer.fiscalCode,
                  certificateSubject: commit.signer.certificateSubject,
                  certificateIssuer: commit.signer.certificateIssuer,
                }
              : { signaturesDone: sql`${signers.signaturesDone} + 1` }
          )
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
        if (commit.final) await tx.insert(events).values(commit.event)
        if (commit.complete)
          await tx.insert(events).values({ requestId: commit.requestId, actorSub: null, type: "completed" })
        if (profile && !profile.fiscalCode && fiscalCode)
          await tx.update(profiles).set({ fiscalCode, certificateSubject }).where(eq(profiles.sub, commit.identity.sub))
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
