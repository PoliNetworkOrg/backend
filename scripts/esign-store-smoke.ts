/**
 * Exercises the e-signing Postgres store against a disposable database (see .env.local):
 * `bun scripts/esign-store-smoke.ts`. Creates its own rows and deletes them.
 */
import { randomUUID } from "node:crypto"
import { DB } from "@/db"
import { createPgStore } from "@/esign/store-pg"

const store = createPgStore(DB)
const sub = `smoke-${randomUUID()}`
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`)
  if (!ok) process.exitCode = 1
}

await store.upsertProfile({ sub, name: "Smoke Test", email: null })
const placement = { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 }
const stage = () =>
  store.insertDocument({
    requestId: null,
    version: 0,
    fileName: "smoke.pdf",
    content: new Uint8Array([37, 80, 68, 70]),
    sha256: "x",
    size: 4,
    pages: 1,
    source: { kind: "upload" },
    createdBySub: sub,
  })
const create = async () =>
  store.createRequest({
    title: "smoke",
    ordered: true,
    drives: [],
    output: null,
    email: null,
    createdBySub: sub,
    documentId: (await stage()).id,
    signers: [{ sub, name: "Smoke Test", role: null, places: [{ ...placement, kind: "signature" }] }],
  })

const a = await create()
const job = await store.createJob({
  ticketHash: randomUUID(),
  requestId: a.id,
  signerId: a.signers[0].id,
  sub,
  baseVersion: 0,
  places: [{ ...placement, kind: "signature" }],
  step: 0,
  expiresAt: new Date(Date.now() + 60_000),
})
await store.transitionJob(job.id, ["pending"], { status: "prepared" })
const commit = (
  fiscalCode: string,
  jobId: string,
  requestId: string,
  signerId: string,
  final = true,
  baseVersion = 0
) =>
  store.commitSignature({
    jobId,
    requestId,
    baseVersion,
    document: {
      requestId,
      version: baseVersion + 1,
      fileName: "smoke.pdf",
      content: new Uint8Array([1]),
      sha256: "y",
      size: 1,
      pages: 1,
      source: { kind: "upload" },
      createdBySub: sub,
    },
    signer: { id: signerId, fiscalCode, certificateSubject: "CN=x", certificateIssuer: "CA" },
    final,
    complete: final,
    identity: { sub, fiscalCode, certificateSubject: "CN=x" },
    event: { requestId, actorSub: sub, type: "signed", data: null },
  })
check("commit binds the fiscal code", (await commit("AAA", job.id, a.id, a.signers[0].id)) === "ok")
check("profile bound", (await store.getProfile(sub))?.fiscalCode === "AAA")
check(
  "cancel after completion conflicts",
  (await store.cancelRequest(a.id, { requestId: a.id, actorSub: sub, type: "cancelled", data: null })) === "conflict"
)
const now = new Date()
check("claim pending delivery", await store.claimDelivery(a.id, now, new Date(now.getTime() - 1000), false))
check("second claim refused", !(await store.claimDelivery(a.id, now, new Date(now.getTime() - 1000), false)))
check("stale claim resumable", (await store.pendingDeliveries(new Date(now.getTime() + 1000))).includes(a.id))

const b = await create()
const job2 = await store.createJob({
  ticketHash: randomUUID(),
  requestId: b.id,
  signerId: b.signers[0].id,
  sub,
  baseVersion: 0,
  places: [{ ...placement, kind: "signature" }],
  step: 0,
  expiresAt: new Date(Date.now() + 60_000),
})
await store.transitionJob(job2.id, ["pending"], { status: "prepared" })
check("another card is refused", (await commit("BBB", job2.id, b.id, b.signers[0].id)) === "mismatch")
check(
  "decline ends the request",
  (await store.declineRequest(b.id, b.signers[0].id, "no", {
    requestId: b.id,
    actorSub: sub,
    type: "declined",
    data: null,
  })) === "ok"
)
check("open jobs cancelled", (await store.openJobs(b.id)).length === 0)
const c = await create()
check(
  "cancel in progress",
  (await store.cancelRequest(c.id, { requestId: c.id, actorSub: sub, type: "cancelled", data: null })) === "ok"
)

// A signer with two places: the first commit moves the job on, the second finishes.
const d = await store.createRequest({
  title: "smoke",
  ordered: true,
  drives: [],
  output: null,
  email: null,
  createdBySub: sub,
  documentId: (await stage()).id,
  signers: [
    {
      sub,
      name: "Smoke Test",
      role: null,
      places: [
        { ...placement, kind: "signature" },
        { ...placement, kind: "signature" },
      ],
    },
  ],
})
const job3 = await store.createJob({
  ticketHash: randomUUID(),
  requestId: d.id,
  signerId: d.signers[0].id,
  sub,
  baseVersion: 0,
  places: d.signers[0].places,
  step: 0,
  expiresAt: new Date(Date.now() + 60_000),
})
await store.transitionJob(job3.id, ["pending"], { status: "prepared" })
check("first place commits", (await commit("AAA", job3.id, d.id, d.signers[0].id, false)) === "ok")
const afterFirst = await store.getJob(job3.id)
check(
  "job moves to the next place",
  afterFirst?.status === "pending" && afterFirst.step === 1 && afterFirst.baseVersion === 1
)
const signerAfterFirst = (await store.getRequest(d.id))?.signers[0]
check("signer still pending", signerAfterFirst?.status === "pending" && signerAfterFirst.signaturesDone === 1)
await store.transitionJob(job3.id, ["pending"], { status: "prepared" })
check("last place commits", (await commit("AAA", job3.id, d.id, d.signers[0].id, true, 1)) === "ok")
check("request completed", (await store.getRequest(d.id))?.status === "completed")

// Drive access rules: insert, then replace.
const driveId = `smoke-${randomUUID()}`
await store.setDriveAccess({
  driveId,
  request: { roles: ["direttivo"], permissions: [] },
  sign: { roles: [], permissions: ["esign:sign"] },
  updatedBySub: sub,
})
await store.setDriveAccess({
  driveId,
  request: { roles: ["direttivo", "socio"], permissions: ["esign:x"] },
  sign: { roles: [], permissions: [] },
  updatedBySub: sub,
})
const rule = (await store.listDriveAccess()).find((r) => r.driveId === driveId)
check(
  "drive access replaced",
  rule?.request.roles.join() === "direttivo,socio" &&
    rule.request.permissions.join() === "esign:x" &&
    rule.sign.permissions.length === 0
)

const { sql } = await import("drizzle-orm")
await DB.execute(sql`delete from esign_requests where created_by_sub = ${sub}`)
await DB.execute(sql`delete from esign_profiles where sub = ${sub}`)
await DB.execute(sql`delete from esign_drive_access where drive_id = ${driveId}`)
process.exit()
