import { createHash, randomUUID } from "node:crypto"
import { and, eq, inArray, sql } from "drizzle-orm"
import type { DB } from "@/db"
import { documents, events, jobs, profiles, requests, signers } from "@/db/schema/esign/esign"
import { files, identities, receiptRequests, receipts, records } from "@/db/schema/people"
import { EsignError } from "@/esign/errors"
import type { SignatureCommit } from "@/esign/store"
import { emptyState, type PeopleState, type PeopleStore, type StoredReceipt, type UnitOfWork } from "./types"

export type Database = typeof DB
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
/** Lock order: People metadata, eSign request, eSign profile. Shared by void, preparation and completion. */
export const lockPeople = (tx: Transaction) => tx.execute(sql`select pg_advisory_xact_lock(198074, 1)`)

export async function loadState(tx: Transaction): Promise<PeopleState> {
  const state = emptyState()
  for (const row of await tx.select().from(records)) {
    const separator = row.id.indexOf(":")
    Object.assign(state[row.kind], { [row.id.slice(separator + 1)]: row.data })
  }
  for (const row of await tx.select().from(receipts)) state.receipts[row.id] = row.data
  return state
}

export async function saveState(tx: Transaction, state: PeopleState, before: PeopleState) {
  for (const kind of Object.keys(state) as (keyof PeopleState)[]) {
    if (kind === "receipts") continue
    for (const [id, data] of Object.entries(state[kind])) {
      if (JSON.stringify(data) === JSON.stringify(before[kind][id])) continue
      await tx
        .insert(records)
        .values({ id: `${kind}:${id}`, kind, data })
        .onConflictDoUpdate({ target: records.id, set: { data } })
    }
    for (const id of Object.keys(before[kind])) {
      if (!(id in state[kind])) await tx.delete(records).where(eq(records.id, `${kind}:${id}`))
    }
  }
  // Clear changed and removed unique values first so moving an identity between records (or merging them) is atomic.
  const changed = Object.values(state.persons).filter((p) => JSON.stringify(p) !== JSON.stringify(before.persons[p.id]))
  const removed = Object.keys(before.persons).filter((id) => !(id in state.persons))
  if (changed.length || removed.length)
    await tx.delete(identities).where(inArray(identities.personId, [...changed.map((p) => p.id), ...removed]))
  for (const p of changed)
    await tx.insert(identities).values({
      personId: p.id,
      accountSub: p.accountSub,
      memberNumber: p.member?.number,
      telegramId: p.profile.telegramId,
    })
  for (const receipt of Object.values(state.receipts)) {
    if (JSON.stringify(receipt) === JSON.stringify(before.receipts[receipt.id])) continue
    await tx
      .insert(receipts)
      .values({ id: receipt.id, number: receipt.number, requestId: receipt.requestId, data: receipt })
      .onConflictDoUpdate({ target: receipts.id, set: { requestId: receipt.requestId, data: receipt } })
  }
}

export function unitOfWork(tx: Transaction, state: PeopleState): UnitOfWork {
  return {
    state,
    async getFile(id) {
      const [file] = await tx.select().from(files).where(eq(files.id, id))
      return file ? { ...file, expiresAt: file.expiresAt?.toISOString() ?? null } : null
    },
    async putFile(file) {
      await tx
        .insert(files)
        .values({ ...file, expiresAt: file.expiresAt ? new Date(file.expiresAt) : null })
        .onConflictDoUpdate({ target: files.id, set: { expiresAt: file.expiresAt ? new Date(file.expiresAt) : null } })
    },
    async deleteFile(id) {
      await tx.delete(files).where(eq(files.id, id))
    },
    async prepareRequest(receipt, sub, signerName) {
      const title = `Receipt ${receipt.number} · ${receipt.person.name}`
      if (receipt.requestId) {
        const [existing] = await tx.select().from(requests).where(eq(requests.id, receipt.requestId))
        const [mapping] = await tx
          .select()
          .from(receiptRequests)
          .where(eq(receiptRequests.requestId, receipt.requestId))
        if (
          existing?.status === "in_progress" &&
          mapping?.officerSub === sub &&
          mapping.originalHash === receipt.sha256
        )
          return { requestId: receipt.requestId, title }
        await this.invalidateRequest(receipt, sub)
      }
      const original = await this.getFile(receipt.originalFileId)
      if (!original || createHash("sha256").update(original.content).digest("hex") !== receipt.sha256)
        throw new EsignError("conflict", "The issued receipt changed")
      const id = randomUUID()
      await tx.insert(profiles).values({ sub, name: signerName }).onConflictDoNothing()
      await tx
        .insert(requests)
        .values({ id, title, ordered: true, createdBySub: sub, drives: [], output: null, email: null })
      await tx.insert(documents).values({
        requestId: id,
        version: 0,
        fileName: original.fileName,
        content: original.content,
        sha256: receipt.sha256,
        size: original.content.length,
        pages: 1,
        source: { kind: "upload" },
        createdBySub: sub,
      })
      await tx.insert(signers).values({
        requestId: id,
        position: 0,
        sub,
        name: signerName,
        role: receipt.signer === "president" ? "Presidente" : "Vicepresidente",
        places: [{ kind: "signature", page: 0, x: 0.56, y: 0.69, width: 0.35, height: 0.09 }],
      })
      receipt.requestId = id
      await tx
        .insert(receipts)
        .values({ id: receipt.id, number: receipt.number, requestId: id, data: receipt })
        .onConflictDoUpdate({ target: receipts.id, set: { requestId: id, data: receipt } })
      await tx
        .insert(receiptRequests)
        .values({ requestId: id, receiptId: receipt.id, officerSub: sub, originalHash: receipt.sha256 })
      await tx
        .insert(events)
        .values({ requestId: id, actorSub: sub, type: "created", data: { peopleReceipt: receipt.id } })
      return { requestId: id, title }
    },
    async invalidateRequest(receipt, actor) {
      if (!receipt.requestId) return
      const [request] = await tx.select().from(requests).where(eq(requests.id, receipt.requestId)).for("update")
      if (request?.status === "in_progress") {
        await tx
          .update(requests)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(requests.id, request.id))
        await tx
          .update(jobs)
          .set({ status: "cancelled", preparedPdf: null })
          .where(and(eq(jobs.requestId, request.id), inArray(jobs.status, ["pending", "prepared"])))
        await tx.insert(events).values({ requestId: request.id, actorSub: actor, type: "people_invalidated" })
      }
    },
  }
}

export function createPeoplePgStore(db: Database): PeopleStore {
  return {
    transaction: (fn) =>
      db.transaction(async (tx) => {
        await lockPeople(tx)
        const state = await loadState(tx)
        const before = structuredClone(state)
        const result = await fn(unitOfWork(tx, state))
        await saveState(tx, state, before)
        return result
      }),
  }
}

/** Called inside eSign's transaction before it locks the request. */
export async function guardReceiptSignature(
  tx: Transaction,
  commit: SignatureCommit,
  eligible: (receipt: StoredReceipt, sub: string, state: PeopleState, requireEsign: boolean) => boolean
) {
  const [mapping] = await tx.select().from(receiptRequests).where(eq(receiptRequests.requestId, commit.requestId))
  if (!mapping) return
  await lockPeople(tx)
  const state = await loadState(tx)
  const receipt = state.receipts[mapping.receiptId]
  if (
    !receipt ||
    receipt.requestId !== commit.requestId ||
    receipt.status !== "toSign" ||
    receipt.sha256 !== mapping.originalHash ||
    mapping.officerSub !== commit.identity.sub ||
    commit.baseVersion !== 0 ||
    !eligible(receipt, commit.identity.sub, state, !commit.receiptManual)
  )
    throw new EsignError("forbidden", "This receipt is no longer assigned to you")
}

/** Signature, retained PDF, activity and a unique delivery intent commit together. */
export async function completeReceiptSignature(tx: Transaction, commit: SignatureCommit) {
  if (!commit.complete) return
  const [mapping] = await tx.select().from(receiptRequests).where(eq(receiptRequests.requestId, commit.requestId))
  if (!mapping) return
  const state = await loadState(tx)
  const before = structuredClone(state)
  const receipt = state.receipts[mapping.receiptId]
  const fileId = `signed:${receipt.id}`
  await unitOfWork(tx, state).putFile({
    id: fileId,
    fileName: commit.receiptEnvelope?.fileName ?? commit.document.fileName,
    contentType: commit.receiptEnvelope ? "application/pkcs7-mime" : "application/pdf",
    content: commit.receiptEnvelope?.content ?? commit.document.content,
    expiresAt: null,
  })
  receipt.signedFileId = fileId
  receipt.status = "signed"
  receipt.signedBy =
    typeof commit.event.data?.name === "string" ? commit.event.data.name : commit.identity.certificateSubject
  receipt.signedOn = new Date().toISOString()
  state.persons[receipt.person.id].activity.unshift({
    actor: commit.identity.sub,
    text: `Signed receipt ${receipt.number}`,
    at: receipt.signedOn,
  })
  const id = `receipt:${receipt.id}`
  state.outbox[id] ??= {
    id,
    personId: receipt.person.id,
    receiptId: receipt.id,
    to: receipt.recipient,
    subject: `Ricevuta ${receipt.number} · PoliNetwork`,
    text: `grazie per aver versato la quota associativa ${receipt.year} di PoliNetwork. In allegato trovi la ricevuta ${receipt.number}, firmata digitalmente: conservala, vale come prova del pagamento.`,
    fileId,
    status: "pending",
    attemptedAt: null,
    error: null,
  }
  await saveState(tx, state, before)
}
