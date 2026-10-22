import assert from "node:assert/strict"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { schema } from "@/db/schema"
import { jobs, requests as requestTable } from "@/db/schema/esign/esign"
import { identities, receiptRequests, receipts } from "@/db/schema/people"
import { buildSignedData, CMS_OID, dataToBeSigned, sha256, signedAttributes } from "@/esign/pdf/cms"
import { children, contextTag, octetString, oid, read, sequence } from "@/esign/pdf/der"
import { inspectPdf } from "@/esign/pdf/inspect"
import { finalizeSignature, prepareSignature } from "@/esign/pdf/pades"
import { createEsignService } from "@/esign/service"
import { createPgStore } from "@/esign/store-pg"
import { transferType } from "@/people/files"
import { newPerson, receiptEligible } from "@/people/model"
import { createPeopleService } from "@/people/service"
import { completeReceiptSignature, createPeoplePgStore, guardReceiptSignature } from "@/people/store-pg"
import type { PeopleConfig, PeopleState, Viewer } from "@/people/types"
import { cardSign, createTestCa } from "./esign-fixtures"

const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const databaseName = `people_test_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName })
const db = drizzle({ client, schema })
const checked: string[] = []
try {
  await migrate(db, { migrationsFolder: "./drizzle" })
  const store = createPeoplePgStore(db)
  const config: PeopleConfig = {
    officers: { president: "P-0001", vicePresident: "P-0002" },
    feeCents: 1000,
    beneficiary: "PoliNetwork APS",
    iban: "IT60X0542811101000000123456",
    legalName: "PoliNetwork APS",
    address: "Via Test 1, Milano",
    taxCode: "12345678901",
    dashboardUrl: "https://admin.example.org",
  }
  const permissionSet = new Set([
    "admin:access",
    "people:self",
    "people:read",
    "people:write",
    "people:members:read",
    "people:members:write",
    "people:fees:write",
    "people:receipts:sign",
    "people:appoint",
    "esign:sign",
  ])
  const viewer = (sub: string): Viewer => ({ sub, telegramId: null, can: (p) => permissionSet.has(p) })
  const president = viewer("president")
  const vice = viewer("vice")
  const directory = [
    { sub: "president", name: "Mario Rossi", email: "president@example.org", emailVerified: true, telegramId: "101" },
    { sub: "vice", name: "Anna Bianchi", email: "vice@example.org", emailVerified: true, telegramId: "102" },
    { sub: "member", name: "Luca Verdi", email: "member@example.org", emailVerified: true, telegramId: "103" },
  ]
  const outboxCalls: string[] = []
  const eligible = (r: PeopleState["receipts"][string], sub: string, state: PeopleState, requireEsign: boolean) =>
    receiptEligible(state, r, viewer(sub), config, requireEsign)
  const esignStore = createPgStore(db, {
    beforeSignature: (tx, commit) => guardReceiptSignature(tx, commit, eligible),
    afterSignature: completeReceiptSignature,
  })
  const esign = createEsignService({
    store: esignStore,
    drives: [],
    directory: async () => directory,
    access: () => ({ roles: [], permissions: [...permissionSet] }),
    receiptCanView: (receiptId, sub) => people.canViewReceipt(receiptId, sub, viewer(sub).can),
    receiptEligible: async (id, sub, requireEsign) => people.eligibleReceipt(id, sub, viewer(sub).can, requireEsign),
    mailer: {
      signatureRequest: async () => true,
      signedDocument: async () => {
        throw new Error("eSign must never send receipt email")
      },
      requestUpdate: async () => true,
    },
    logger: { info() {}, warn() {}, error() {} },
    dashboardUrl: config.dashboardUrl,
    allowTestCertificates: true,
    revocation: "off",
  })
  const people = createPeopleService({
    store,
    config,
    directory: async () => directory,
    telegramGroups: async () => [],
    telegramUsers: async () => [],
    provisionMember: async (p) => ({
      id: `azure-${p.id}`,
      email: `${p.profile.firstName.toLowerCase()}@polinetwork.org`,
    }),
    setMemberNumber: async () => {},
    sendMail: async (m) => {
      outboxCalls.push(m.id)
    },
    inspectSigned: (sub, bytes) => esign.inspectUpload(sub, bytes),
    verifySigned: (sub, id, bytes) => esign.verifyUpload({ sub, canManage: false, peopleManual: true }, id, bytes),
    completeSigned: async (sub, id, bytes) => {
      await esign.uploadSigned({ sub, canManage: false, peopleManual: true }, id, bytes)
    },
    transferType,
  })
  await store.transaction(async ({ state }) => {
    for (const a of directory) {
      const [firstName, lastName] = a.name.split(" ")
      const p = newPerson(
        state,
        {
          firstName,
          lastName,
          personalEmail: a.email,
          phone: "",
          telegramUsername: "",
          course: "Informatica",
          year: "2nd year",
          campus: "Leonardo",
          admin: true,
        },
        "2026-10-01"
      )
      p.accountSub = a.sub
      p.profile.telegramId = a.telegramId
      p.account = { status: "linked", email: a.email, via: "IdP", linkedOn: "2026-10-01", how: "fixture" }
    }
  })
  assert.equal((await people.listPeople(president)).length, 3)
  checked.push("migrations and PostgreSQL metadata round-trip")
  await people.createMember(president, { personId: "P-0003", number: "0003", admittedOn: "2026-10-01", fee: "due" })
  const payment = {
    personId: "P-0003",
    paidOn: "2026-10-17",
    amountCents: 1000,
    method: "cash" as const,
    note: "Integration test",
  }
  const issueResults = await Promise.allSettled([
    people.markFeePaid(president, payment),
    people.markFeePaid(president, payment),
  ])
  assert.equal(issueResults.filter((r) => r.status === "fulfilled").length, 1)
  let [receipt] = await db.select().from(receipts)
  assert.equal(receipt.number, "2026/001")
  const [a, b] = await Promise.all([
    people.prepareReceiptSignatures(president, { receiptIds: [receipt.id] }),
    people.prepareReceiptSignatures(president, { receiptIds: [receipt.id] }),
  ])
  assert.equal(a[0].requestId, b[0].requestId)
  assert.equal((await db.select().from(receiptRequests)).length, 1)
  checked.push("concurrent issue and idempotent receipt/request uniqueness")
  const requestId = a[0].requestId
  const caller = { sub: "president", canManage: true }
  assert.deepEqual((await esign.getRequest(caller, requestId)).request.peopleReceipt, {
    receiptId: receipt.id,
    number: receipt.number,
    year: "2026/27",
  })
  assert.equal((await esign.listRequests(caller, "inbox"))[0].myTurn, true)
  await assert.rejects(esign.cancelRequest(caller, requestId), /Void receipts/)
  await assert.rejects(esign.deleteRequest(caller, requestId), /retained/)
  await assert.rejects(
    esign.createJob(caller, requestId, [{ page: 0, x: 0.1, y: 0.1, width: 0.1, height: 0.1 }]),
    /fixed/
  )
  checked.push("eSign provenance, fixed placement and permanent receipt retention")
  const ca = await createTestCa()
  const signer = await ca.issue("ROSSI MARIO", "RSSMRA80A01F205X")
  const { ticket } = await esign.createJob(caller, requestId)
  await esign.agentJob(ticket)
  const prepared = await esign.agentPrepare(ticket, Buffer.from(signer.cert).toString("base64"), [], 2)
  const signature = await cardSign(signer, new Uint8Array(Buffer.from(prepared.toBeSigned, "base64")))
  permissionSet.delete("people:receipts:sign")
  assert.equal((await esign.getRequest(caller, requestId)).request.myTurn, false)
  await assert.rejects(esign.agentComplete(ticket, Buffer.from(signature).toString("base64")), /assigned/)
  permissionSet.add("people:receipts:sign")
  await esign.agentComplete(ticket, Buffer.from(signature).toString("base64"))
  ;[receipt] = await db.select().from(receipts)
  assert.equal(receipt.data.status, "signed")
  assert.equal((await store.transaction(async ({ state }) => Object.keys(state.outbox))).length, 1)
  // No browser callbacks: a fresh service worker drains the persistent outbox.
  await Promise.all([people.deliverPending(), people.deliverPending()])
  assert.equal(outboxCalls.length, 1)
  ;[receipt] = await db.select().from(receipts)
  assert.equal(receipt.data.status, "sent")
  const own = await people.downloadMyReceipt(viewer("member"), { receiptId: receipt.id })
  assert.equal((await inspectPdf(new Uint8Array(Buffer.from(own.base64, "base64")))).signatures[0].verified, true)
  checked.push("real RSA/CIE job, permission revocation, atomic completion and one durable email")
  await assert.rejects(people.downloadMyReceipt(vice, { receiptId: receipt.id }), /not found/)
  await people.voidReceipt(president, { receiptId: receipt.id, reason: "Test replacement" })
  await people.markFeePaid(president, payment)
  const all = await db.select().from(receipts)
  const replacement = all.find((r) => r.number === "2026/002")
  assert.ok(replacement)
  const [replacementRequest] = await people.prepareReceiptSignatures(president, { receiptIds: [replacement.id] })
  const replacementOriginal = await esignStore.latestDocument(replacementRequest.requestId)
  assert.ok(replacementOriginal)
  const external = await prepareSignature(replacementOriginal.content, signer.cert, {
    placement: { page: 0, x: 0.56, y: 0.69, width: 0.35, height: 0.09 },
    signerName: "Mario Rossi",
    fieldName: "Firma",
    signingTime: new Date(),
    reason: "Membership fee",
    appearance: { lines: [{ text: "Mario Rossi" }] },
  })
  const signedPdf = finalizeSignature(external, await cardSign(signer, external.toBeSigned))
  const pendingJob = await esign.createJob(caller, replacementRequest.requestId)
  // The manual path commits through exactly the same transaction and cancels the agent's older job.
  const upload = await people.previewSignedReceipts(president, {
    files: [new File([new Uint8Array(signedPdf)], "unmatched.pdf")],
  })
  assert.equal(upload.files[0].signature.valid, true)
  assert.equal(upload.files[0].receiptId, null)
  assert.deepEqual(
    await people.sendSignedReceipts(president, {
      uploadId: upload.uploadId,
      assignments: { [upload.files[0].fileId]: replacement.id },
    }),
    { sent: 1, failed: 0 }
  )
  assert.equal((await esignStore.getJob(pendingJob.jobId))?.status, "cancelled")
  await assert.rejects(
    esign.agentPrepare(pendingJob.ticket, Buffer.from(signer.cert).toString("base64"), [], 2),
    /cancelled|no longer|already signed/
  )
  checked.push("manual PAdES correction, shared completion, race invalidation and non-reused numbers")
  await people.voidReceipt(president, { receiptId: replacement.id, reason: "Voided after signing" })
  assert.equal(
    (await db.select().from(requestTable).where(eq(requestTable.id, replacementRequest.requestId)))[0].status,
    "completed"
  )
  assert.equal(
    (await db.select().from(jobs)).filter((j) => j.status === "prepared" || j.status === "pending").length,
    0
  )
  assert.equal((await db.select().from(receiptRequests)).length, 2)
  checked.push("voiding preserves signed files, association history and finished eSign requests")
  await people.markFeePaid(president, payment)
  const third = (await db.select().from(receipts)).find((r) => r.number === "2026/003")
  assert.ok(third)
  const [thirdRequest] = await people.prepareReceiptSignatures(president, { receiptIds: [third.id] })
  const thirdOriginal = await esignStore.latestDocument(thirdRequest.requestId)
  assert.ok(thirdOriginal)
  const attrs = signedAttributes(sha256(thirdOriginal.content), signer.cert)
  const detached = buildSignedData({
    signedAttrs: attrs,
    signature: await cardSign(signer, dataToBeSigned(attrs)),
    certDer: signer.cert,
  })
  const sd = children(children(children(read(detached))[1])[0])
  const envelope = sequence(
    oid(CMS_OID.signedData),
    contextTag(
      0,
      sequence(
        ...sd.map((part, index) =>
          index === 2 ? sequence(oid(CMS_OID.data), contextTag(0, octetString(thirdOriginal.content))) : part.raw
        )
      )
    )
  )
  const cmsUpload = await people.previewSignedReceipts(president, {
    files: [new File([new Uint8Array(envelope)], "Ricevuta_2026-003.pdf.p7m")],
  })
  assert.equal(cmsUpload.files[0].signature.valid, true)
  assert.deepEqual(
    await people.sendSignedReceipts(president, {
      uploadId: cmsUpload.uploadId,
      assignments: { [cmsUpload.files[0].fileId]: third.id },
    }),
    { sent: 1, failed: 0 }
  )
  const signedEnvelope = await people.downloadMyReceipt(viewer("member"), { receiptId: third.id })
  assert.equal(signedEnvelope.contentType, "application/pkcs7-mime")
  assert.deepEqual(Buffer.from(signedEnvelope.base64, "base64"), Buffer.from(envelope))
  checked.push("CAdES envelope verifies the exact issued PDF and retains the original cryptographic evidence")
  const duplicates = await store.transaction(async ({ state }) =>
    ["104", null].map((telegramId) => {
      const p = newPerson(
        state,
        {
          firstName: "Sara",
          lastName: "Neri",
          personalEmail: "sara@example.org",
          phone: "",
          telegramUsername: "",
          course: "Informatica",
          year: "1st year",
          campus: "Leonardo",
          admin: false,
        },
        "2026-10-01"
      )
      p.profile.telegramId = telegramId
      return p.id
    })
  )
  await people.createMember(president, {
    personId: duplicates[1],
    number: "0042",
    admittedOn: "2026-10-01",
    fee: "due",
  })
  directory.push({ sub: "sara", name: "Sara Neri", email: "sara@example.org", emailVerified: true, telegramId: "104" })
  await people.getMyArea(viewer("sara"))
  const review = (await people.listReviews(president)).find((r) => r.kind === "two-records")
  assert.ok(review)
  await people.resolveReview(president, { reviewId: review.id, resolution: "merge-first", reason: "Same student" })
  // The removed record's unique identities are released before the retained record takes them over.
  const merged = (await db.select().from(identities)).find((i) => i.personId === duplicates[0])
  assert.deepEqual(merged, { personId: duplicates[0], accountSub: "sara", memberNumber: "0042", telegramId: "104" })
  assert.equal((await db.select().from(identities)).filter((i) => i.personId === duplicates[1]).length, 0)
  assert.equal((await people.getMyArea(viewer("sara"))).state, "linked")
  checked.push("merging duplicates moves membership and identities without unique violations")
  console.log(JSON.stringify({ checked }))
} finally {
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
