import { randomBytes, X509Certificate } from "node:crypto"
import { PDFDocument, PDFName, PDFRef } from "pdf-lib"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMockDrive } from "@/esign/drive/mock"
import { EsignError } from "@/esign/errors"
import { dataToBeSigned, sha256, signedAttributes } from "@/esign/pdf/cms"
import { signedBytes } from "@/esign/pdf/incremental"
import { inspectPdf } from "@/esign/pdf/inspect"
import { finalizeSignature, prepareSignature } from "@/esign/pdf/pades"
import { type Access, type Caller, createEsignService, type Mailer } from "@/esign/service"
import type { EsignStore } from "@/esign/store"
import { createMemoryStore } from "@/esign/store-memory"
import { appendRevision, cardSign, createTestCa, samplePdf, type TestSigner } from "./esign-fixtures"

const ca = await createTestCa()
const secretarySigner = await ca.issue("ROSSI MARIO", "RSSMRA80A01F205X")
const presidentSigner = await ca.issue("BIANCHI ANNA", "BNCNNA85B41F205Y")

const manager: Caller = { sub: "sub-manager", canManage: true }
const secretary: Caller = { sub: "sub-secretary", canManage: false }
const president: Caller = { sub: "sub-president", canManage: false }

const placement = (page: number) => ({ page, x: 0.1, y: 0.8, width: 0.35, height: 0.1 })

function setup(
  opts: {
    allowTestCertificates?: boolean
    revocation?: "good" | "revoked" | "unknown"
    policy?: "require" | "prefer" | "off"
    directory?: () => Promise<{ sub: string; name: string; email: string | null }[]>
    /** Another service instance's store: a replica, or the service after a restart. */
    store?: EsignStore
  } = {}
) {
  let clock = new Date("2026-10-17T10:00:00Z").getTime()
  const store = opts.store ?? createMemoryStore()
  const drive = createMockDrive()
  const archive = createMockDrive({ id: "archive", label: "Archive" })
  /** Roles and permissions by subject, for drive access rules. */
  const people = new Map<string, Access>()
  const mailer = {
    signatureRequest: vi.fn<Mailer["signatureRequest"]>().mockResolvedValue(true),
    signedDocument: vi.fn<Mailer["signedDocument"]>().mockResolvedValue(true),
  }
  const service = createEsignService({
    store,
    drives: [drive, archive],
    access: (sub) => people.get(sub) ?? null,
    directory: opts.directory,
    mailer,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dashboardUrl: "https://admin.example.org",
    allowTestCertificates: opts.allowTestCertificates ?? true,
    revocation: opts.policy ?? "prefer",
    // The test CA plays the CIE CA when a revocation outcome is set, so the OCSP policy applies.
    trust: opts.revocation
      ? () => ({ trusted: true, chain: [], issuer: new X509Certificate(Buffer.from(ca.cert.rawData)) })
      : undefined,
    checkRevocation: async () => ({
      status: opts.revocation ?? "good",
      detail: null,
      checkedAt: new Date().toISOString(),
    }),
    now: () => new Date(clock),
  })
  const advance = (ms: number) => {
    clock += ms
  }
  return { service, store, drive, archive, people, mailer, advance }
}

async function prepareRequest(env: ReturnType<typeof setup>, ordered = true) {
  const { service } = env
  await service.syncProfile(manager, { name: "Luca Verdi", email: "luca@example.org" })
  await service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
  await service.syncProfile(president, { name: "Anna Bianchi", email: "anna@example.org" })
  const { document } = await service.stageUpload(manager, "verbale.pdf", await samplePdf())
  return service.createRequest(manager, {
    title: "Verbale CD 10/10/2026",
    documentId: document.id,
    ordered,
    signers: [
      { sub: secretary.sub, role: "segretario", places: [{ ...placement(0), kind: "signature" as const }] },
      { sub: president.sub, role: "presidente", places: [{ ...placement(1), kind: "signature" as const }] },
    ],
    output: { driveId: "dev", folderId: "mock-firmati", fileName: "Verbale CD firmato" },
    email: { to: ["archivio@example.org"], message: "In allegato il verbale." },
  })
}

async function sign(env: ReturnType<typeof setup>, caller: Caller, signer: TestSigner, requestId: string) {
  const { ticket } = await env.service.createJob(caller, requestId)
  const job = await env.service.agentJob(ticket)
  const { toBeSigned } = await env.service.agentPrepare(ticket, Buffer.from(signer.cert).toString("base64"), [], 2)
  const signature = await cardSign(signer, new Uint8Array(Buffer.from(toBeSigned, "base64")))
  const done = await env.service.agentComplete(ticket, Buffer.from(signature).toString("base64"))
  return { job, done, ticket }
}

/** Signs a job to the end as the agent does: one card session, a prepare and a complete per signature place. */
async function signJob(env: ReturnType<typeof setup>, signer: TestSigner, ticket: string) {
  const statuses: string[] = []
  for (;;) {
    const { toBeSigned } = await env.service.agentPrepare(ticket, Buffer.from(signer.cert).toString("base64"), [], 2)
    const signature = await cardSign(signer, new Uint8Array(Buffer.from(toBeSigned, "base64")))
    const done = await env.service.agentComplete(ticket, Buffer.from(signature).toString("base64"))
    statuses.push(done.status)
    if (done.status === "completed") return statuses
  }
}

async function stampsOn(pdf: Uint8Array, page: number) {
  const doc = await PDFDocument.load(pdf)
  const annots = doc.getPage(page).node.Annots()
  return (annots?.asArray() ?? []).filter((ref) => String(doc.context.lookup(ref)).includes("/Stamp")).length
}

describe("e-signing service", () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  it("lists and accepts registered eligible signers before their first visit", async () => {
    const fresh = { sub: "sub-new", name: "New Signer", email: "new@example.org" }
    env = setup({ directory: async () => [fresh, { sub: "sub-no-access", name: "No Access", email: null }] })
    env.people.set(fresh.sub, { roles: [], permissions: ["esign:sign"] })
    expect(await env.store.getProfile(fresh.sub)).toBeNull()
    expect((await env.service.listProfiles()).map((person) => person.sub)).toEqual([fresh.sub])

    const { document } = await env.service.stageUpload(manager, "request.pdf", await samplePdf())
    await expect(
      env.service.createRequest(manager, {
        title: "Request",
        documentId: document.id,
        ordered: true,
        signers: [{ sub: "sub-no-access", role: null, places: [{ ...placement(0), kind: "signature" }] }],
        output: null,
        email: null,
      })
    ).rejects.toThrow("No Access is not allowed to sign")
    const request = await env.service.createRequest(manager, {
      title: "Request",
      documentId: document.id,
      ordered: true,
      signers: [{ sub: fresh.sub, role: null, places: [{ ...placement(0), kind: "signature" }] }],
      output: null,
      email: null,
    })
    expect(request.signers[0]).toMatchObject({ sub: fresh.sub, name: fresh.name })
    expect(await env.store.getProfile(fresh.sub)).toMatchObject(fresh)
  })

  it("keeps a signer's known email when the IdP directory has none", async () => {
    const known = { sub: "sub-known", name: "Known Signer", email: "known@polinetwork.org" }
    env = setup({ directory: async () => [{ ...known, name: "Known Signer (IdP)", email: null }] })
    env.people.set(known.sub, { roles: [], permissions: ["esign:sign"] })
    await env.store.upsertProfile(known)
    expect(await env.service.listProfiles()).toEqual([
      expect.objectContaining({ sub: known.sub, name: "Known Signer (IdP)", email: known.email }),
    ])

    const { document } = await env.service.stageUpload(manager, "request.pdf", await samplePdf())
    await env.service.createRequest(manager, {
      title: "Request",
      documentId: document.id,
      ordered: true,
      signers: [{ sub: known.sub, role: null, places: [{ ...placement(0), kind: "signature" }] }],
      output: null,
      email: null,
    })
    expect(await env.store.getProfile(known.sub)).toMatchObject({ name: "Known Signer (IdP)", email: known.email })
  })

  it("collects signatures in order, then uploads and emails the signed PDF", async () => {
    const request = await prepareRequest(env)
    expect(request.turn).toEqual([secretary.sub])
    expect(env.mailer.signatureRequest).toHaveBeenCalledWith(
      "mario@example.org",
      expect.objectContaining({
        role: "segretario",
        ordered: true,
        setupUrl: "https://admin.example.org/dashboard/esign/setup",
      })
    )

    expect(await env.service.listRequests(secretary, "inbox")).toHaveLength(1)
    expect(await env.service.listRequests(president, "inbox")).toHaveLength(0)
    await expect(env.service.createJob(president, request.id)).rejects.toMatchObject({ code: "forbidden" })

    const first = await sign(env, secretary, secretarySigner, request.id)
    expect(first.job.document.title).toBe("Verbale CD 10/10/2026")
    expect(first.done.request).toEqual({ status: "in_progress", remaining: 1 })
    await vi.waitFor(() =>
      expect(env.mailer.signatureRequest).toHaveBeenCalledWith("anna@example.org", expect.anything())
    )

    const second = await sign(env, president, presidentSigner, request.id)
    expect(second.done.request).toEqual({ status: "completed", remaining: 0 })

    await vi.waitFor(async () => {
      const { request: done } = await env.service.getRequest(manager, request.id)
      expect(done.delivery?.status).toBe("delivered")
    })
    expect(env.mailer.signatureRequest).toHaveBeenCalledTimes(2)
    const { request: done, versions, events } = await env.service.getRequest(manager, request.id)
    expect(versions.map((v) => v.version)).toEqual([0, 1, 2])
    expect(done.signers.map((s) => s.fiscalCode)).toEqual(["RSSMRA80A01F205X", "BNCNNA85B41F205Y"])
    expect(done.delivery?.driveItem?.name).toBe("Verbale CD firmato.pdf")
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["created", "signed", "completed", "uploaded", "emailed"])
    )

    const uploaded = await env.drive.download(done.delivery?.driveItem?.id ?? "")
    const pdf = await inspectPdf(uploaded.bytes)
    expect(pdf.signatures.map((s) => [s.signerName, s.intact && s.verified])).toEqual([
      ["Mario Rossi", true],
      ["Anna Bianchi", true],
    ])
    const [to, props, attachment] = env.mailer.signedDocument.mock.calls[0]
    expect(to).toEqual(["archivio@example.org"])
    expect(props.signers.map((s) => s.name)).toEqual(["Mario Rossi", "Anna Bianchi"])
    expect(attachment?.filename).toBe("verbale.pdf")
  })

  it("emails every signer of an unordered request once, when it is created", async () => {
    const request = await prepareRequest(env, false)
    expect(env.mailer.signatureRequest).toHaveBeenCalledTimes(2)
    expect(env.mailer.signatureRequest).toHaveBeenCalledWith(
      "anna@example.org",
      expect.objectContaining({ ordered: false })
    )
    await sign(env, secretary, secretarySigner, request.id)
    expect(env.mailer.signatureRequest).toHaveBeenCalledTimes(2)
    const { events } = await env.service.getRequest(manager, request.id)
    expect(events.filter((e) => e.type === "notified")).toHaveLength(2)
  })

  it("doesn't email the creator who signs an unordered request", async () => {
    await env.service.syncProfile(manager, { name: "Luca Verdi", email: "luca@example.org" })
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    const { document } = await env.service.stageUpload(manager, "verbale.pdf", await samplePdf())
    const request = await env.service.createRequest(manager, {
      title: "Verbale",
      documentId: document.id,
      ordered: false,
      signers: [
        { sub: manager.sub, role: null, places: [{ ...placement(0), kind: "signature" }] },
        { sub: secretary.sub, role: null, places: [{ ...placement(1), kind: "signature" }] },
      ],
      output: null,
      email: null,
    })
    await sign(env, secretary, secretarySigner, request.id)
    expect(env.mailer.signatureRequest.mock.calls.map(([to]) => to)).toEqual(["mario@example.org"])
  })

  it("records a signer who couldn't be emailed and why", async () => {
    env.mailer.signatureRequest.mockResolvedValueOnce(false)
    const request = await prepareRequest(env)
    await env.service.syncProfile(president, { name: "Anna Bianchi", email: null })
    await sign(env, secretary, secretarySigner, request.id)
    await vi.waitFor(async () => {
      const { events } = await env.service.getRequest(manager, request.id)
      expect(events.filter((e) => e.type === "notify_failed").map((e) => e.data)).toEqual([
        { sub: secretary.sub, reason: "send_failed" },
        { sub: president.sub, reason: "no_email" },
      ])
    })
    const { events } = await env.service.getRequest(manager, request.id)
    expect(events.some((e) => e.type === "notified")).toBe(false)
  })

  it("binds a signer to the CIE of their first signature, ending a job signed with another", async () => {
    const request = await prepareRequest(env, false)
    await sign(env, secretary, secretarySigner, request.id)
    const other = await prepareRequest(env, false)
    const { ticket, jobId } = await env.service.createJob(secretary, other.id)
    await expect(
      env.service.agentPrepare(ticket, Buffer.from(presidentSigner.cert).toString("base64"), [], 2)
    ).rejects.toMatchObject({ code: "signer_mismatch" })
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject({
      status: "failed",
      errorCode: "signer_mismatch",
      errorMessage: "This CIE does not belong to Mario Rossi",
    })
    expect((await env.service.getRequest(president, other.id)).signingNow).toBeNull()
    await expect(env.service.agentJob(ticket)).rejects.toMatchObject({
      code: "job_failed",
      message: "This CIE does not belong to Mario Rossi",
    })
  })

  it("lets one signer at a time sign an unordered request", async () => {
    const request = await prepareRequest(env, false)
    expect(request.turn).toEqual([secretary.sub, president.sub])
    const { expiresAt } = await env.service.createJob(secretary, request.id)
    expect((await env.service.getRequest(president, request.id)).signingNow).toEqual({
      sub: secretary.sub,
      name: "Mario Rossi",
      until: expiresAt,
    })
    await expect(env.service.createJob(president, request.id)).rejects.toThrow(/Mario Rossi is signing/)
    env.advance(11 * 60 * 1000)
    expect((await env.service.getRequest(president, request.id)).signingNow).toBeNull()
    await expect(env.service.createJob(president, request.id)).resolves.toMatchObject({ ticket: expect.any(String) })
  })

  it("expires tickets and refuses a stale document", async () => {
    const request = await prepareRequest(env, false)
    const { ticket } = await env.service.createJob(secretary, request.id)
    await env.service.agentPrepare(ticket, Buffer.from(secretarySigner.cert).toString("base64"), [], 2)
    env.advance(11 * 60 * 1000)
    await expect(env.service.agentJob(ticket)).rejects.toMatchObject({ code: "job_expired" })
    await sign(env, president, presidentSigner, request.id)
    const again = await env.service.createJob(secretary, request.id)
    const job = await env.service.agentJob(again.ticket)
    expect(job.status).toBe("pending")
  })

  it("rejects certificates outside the CIE CAs in production", async () => {
    env = setup({ allowTestCertificates: false })
    const request = await prepareRequest(env)
    const { ticket } = await env.service.createJob(secretary, request.id)
    await expect(
      env.service.agentPrepare(ticket, Buffer.from(secretarySigner.cert).toString("base64"), [], 2)
    ).rejects.toMatchObject({ code: "certificate_invalid" })
  })

  it("cancels open signatures with the request, saying who cancelled it", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    await env.service.cancelRequest(manager, request.id)
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject({
      status: "cancelled",
      errorCode: "request_cancelled",
      errorMessage: "Luca Verdi cancelled this request.",
    })
    await expect(env.service.agentJob(ticket)).rejects.toMatchObject({
      code: "job_cancelled",
      message: "Luca Verdi cancelled this request.",
    })
    await expect(env.service.createJob(secretary, request.id)).rejects.toMatchObject({
      code: "conflict",
      message: "“Verbale CD 10/10/2026” was cancelled.",
    })
  })

  it("cancels open signatures when a co-signer declines, with the reason", async () => {
    const request = await prepareRequest(env, false)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    await env.service.declineRequest(president, request.id, "Errore nel testo")
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject({
      status: "cancelled",
      errorCode: "request_declined",
      errorMessage: "Anna Bianchi declined this request: “Errore nel testo”.",
    })
    await expect(env.service.agentJob(ticket)).rejects.toThrow(
      "Anna Bianchi declined this request: “Errore nel testo”."
    )
    await expect(env.service.uploadSigned(secretary, request.id, await samplePdf())).rejects.toMatchObject({
      code: "conflict",
      message: "“Verbale CD 10/10/2026” was declined.",
    })
  })

  it("records agent failures without ending the job", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    expect((await env.service.jobStatuses(secretary, [jobId]))[0].seen).toBe(false)
    await env.service.agentJob(ticket)
    await env.service.agentFail(ticket, "pin_incorrect", "Wrong PIN.")
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject({
      status: "pending",
      errorCode: "pin_incorrect",
      seen: true,
    })
    await env.service.agentFail(ticket, "cancelled", null)
    expect((await env.service.jobStatuses(secretary, [jobId]))[0].status).toBe("cancelled")
    await expect(env.service.agentJob(ticket)).rejects.toThrow("This signature was cancelled.")
  })

  it("refuses an agent error that would pass for how the service ended the job", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    for (const code of ["request_cancelled", "request_declined", "job_done", "job_cancelled"])
      await expect(env.service.agentFail(ticket, code, "Luca Verdi cancelled this request.")).rejects.toMatchObject({
        code: "bad_request",
      })
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject({
      status: "pending",
      errorCode: null,
      errorMessage: null,
    })
  })

  it("quotes as much of a long decline reason as fits in the open signatures' message", async () => {
    const request = await prepareRequest(env, false)
    const { jobId } = await env.service.createJob(secretary, request.id)
    const reason = "Il testo del verbale non corrisponde a quanto deliberato. ".repeat(8).trim()
    await env.service.declineRequest(president, request.id, reason)
    const { errorMessage } = (await env.service.jobStatuses(secretary, [jobId]))[0]
    expect(errorMessage?.length).toBeLessThanOrEqual(300)
    expect(errorMessage).toMatch(/^Anna Bianchi declined this request: “Il testo del verbale .+…”\.$/)
    const { request: detail } = await env.service.getRequest(manager, request.id)
    expect(detail.signers.find((s) => s.sub === president.sub)?.declineReason).toBe(reason)
  })

  it("ends the job on an agent error that retrying can't fix", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    await expect(env.service.agentFail(ticket, "pin_locked", "Your CIE PIN is blocked.")).resolves.toEqual({
      status: "failed",
    })
    const failed = { status: "failed", errorCode: "pin_locked", errorMessage: "Your CIE PIN is blocked." }
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject(failed)
    await expect(env.service.agentJob(ticket)).rejects.toMatchObject({
      code: "job_failed",
      message: "Your CIE PIN is blocked.",
    })
    // The agent reports the backend's own errors back: the failed job stays as it is.
    await expect(env.service.agentFail(ticket, "job_failed", "Something else")).resolves.toEqual({ status: "failed" })
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject(failed)
    await expect(env.service.createJob(secretary, request.id)).resolves.toMatchObject({ ticket: expect.any(String) })
  })

  it("accepts a PDF signed with the official CIE app as a fallback", async () => {
    const request = await prepareRequest(env)
    const { request: detail, currentDocumentId } = await env.service.getRequest(manager, request.id)
    const original = (await env.service.document(secretary, currentDocumentId ?? "")).content
    // What Software CIE would produce: the same bytes plus one incremental signature.
    async function externallySigned(signer: TestSigner, pdf = original) {
      const prepared = await prepareSignature(pdf, signer.cert, {
        placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
        fieldName: `Signature-${signer.fiscalCode}`,
        signerName: signer.name,
        signingTime: new Date(),
        appearance: { lines: [{ text: signer.name }] },
      })
      return finalizeSignature(prepared, await cardSign(signer, prepared.toBeSigned))
    }
    expect(detail.turn).toEqual([secretary.sub])
    await expect(
      env.service.uploadSigned(president, request.id, await externallySigned(presidentSigner))
    ).rejects.toMatchObject({
      code: "forbidden",
    })
    const tampered = await externallySigned(secretarySigner)
    tampered[20] ^= 1
    await expect(env.service.uploadSigned(secretary, request.id, tampered)).rejects.toMatchObject({
      code: "pdf_invalid",
    })
    await expect(env.service.uploadSigned(secretary, request.id, original)).rejects.toMatchObject({
      code: "pdf_invalid",
    })

    // The signer can't change the document in the revision they sign…
    const rewritten = await prepareSignature(original, secretarySigner.cert, {
      placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
      fieldName: "Signature1",
      signerName: secretarySigner.name,
      signingTime: new Date(),
      appearance: { lines: [{ text: secretarySigner.name }] },
    })
    const tail = Buffer.from(rewritten.placeholder.pdf.subarray(original.length)).toString("latin1")
    rewritten.placeholder.pdf.set(
      Buffer.from(tail.replace(/\/Contents(?=\s*(?:\[|\d))/, "/ContenXs"), "latin1"),
      original.length
    )
    rewritten.signedAttrs = signedAttributes(
      sha256(signedBytes(rewritten.placeholder.pdf, rewritten.placeholder.byteRange)),
      secretarySigner.cert
    )
    rewritten.toBeSigned = dataToBeSigned(rewritten.signedAttrs)
    const contentRemoved = finalizeSignature(rewritten, await cardSign(secretarySigner, rewritten.toBeSigned))
    await expect(env.service.uploadSigned(secretary, request.id, contentRemoved)).rejects.toThrow(
      /changes the document/
    )

    // …nor leave the new revision out of the signed bytes.
    const gap = await prepareSignature(original, secretarySigner.cert, {
      placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
      fieldName: "Signature1",
      signerName: secretarySigner.name,
      signingTime: new Date(),
      appearance: { lines: [{ text: secretarySigner.name }] },
    })
    const text = Buffer.from(gap.placeholder.pdf).toString("latin1")
    const match = /\/ByteRange (\[[^\]]+\])/.exec(text)
    if (!match) throw new Error("no ByteRange")
    const range: [number, number, number, number] = [0, original.length, gap.placeholder.pdf.length, 0]
    const padded = `[${range.join(" ")}`.padEnd(match[1].length - 1, " ")
    const entry = `${padded}]`
    gap.placeholder.pdf.set(Buffer.from(entry), match.index + "/ByteRange ".length)
    gap.placeholder.byteRange = range
    gap.signedAttrs = signedAttributes(sha256(signedBytes(gap.placeholder.pdf, range)), secretarySigner.cert)
    gap.toBeSigned = dataToBeSigned(gap.signedAttrs)
    const uncovered = finalizeSignature(gap, await cardSign(secretarySigner, gap.toBeSigned))
    await expect(env.service.uploadSigned(secretary, request.id, uncovered)).rejects.toMatchObject({
      code: "signature_invalid",
    })

    const done = await env.service.uploadSigned(secretary, request.id, await externallySigned(secretarySigner))
    expect(done.request).toEqual({ status: "in_progress", remaining: 1 })
    const { request: after, events } = await env.service.getRequest(manager, request.id)
    expect(after.signers[0]).toMatchObject({ status: "signed", fiscalCode: "RSSMRA80A01F205X" })
    expect(events.find((e) => e.type === "signed")?.data).toMatchObject({ method: "upload" })

    const next = await env.service.getRequest(president, request.id)
    const current = (await env.service.document(president, next.currentDocumentId ?? "")).content
    const second = await externallySigned(presidentSigner, current)
    expect((await inspectPdf(second)).signatures).toHaveLength(2)
    await expect(env.service.uploadSigned(president, request.id, second)).resolves.toMatchObject({
      status: "completed",
      request: { status: "completed", remaining: 0 },
    })
  })

  it("refuses an uploaded signature over a revision that draws on the page", async () => {
    const request = await prepareRequest(env)
    const { currentDocumentId } = await env.service.getRequest(manager, request.id)
    const original = (await env.service.document(secretary, currentDocumentId ?? "")).content
    // A valid signature by the right signer, over a revision that also covers the text with a free-text annotation.
    const doc = await PDFDocument.load(original)
    const page = doc.getPage(0)
    const n = doc.context.largestObjectNumber + 1
    page.node.set(PDFName.of("Annots"), doc.context.obj([PDFRef.of(n)]))
    const overlay = "q 1 1 1 rg 0 0 300 40 re f 0 g BT /F1 18 Tf 10 12 Td (Pagina modificata) Tj ET Q"
    const edited = await appendRevision(
      original,
      {
        [page.ref.objectNumber]: page.node.toString(),
        [n]: `<< /Type /Annot /Subtype /FreeText /F 4 /Rect [50 770 350 810] /DA (/F1 18 Tf 0 g) /AP << /N ${n + 1} 0 R >> >>`,
        [n + 1]:
          `<< /Type /XObject /Subtype /Form /BBox [0 0 300 40] /Resources << /Font << /F1 << /Type /Font ` +
          `/Subtype /Type1 /BaseFont /Helvetica >> >> >> /Length ${overlay.length} >>\nstream\n${overlay}\nendstream`,
      },
      n + 2
    )
    const prepared = await prepareSignature(edited, secretarySigner.cert, {
      placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
      fieldName: "Signature1",
      signerName: secretarySigner.name,
      signingTime: new Date(),
      appearance: { lines: [{ text: secretarySigner.name }] },
    })
    const forged = finalizeSignature(prepared, await cardSign(secretarySigner, prepared.toBeSigned))
    const check = await inspectPdf(forged)
    expect(check.signatures.at(-1)).toMatchObject({ intact: true, verified: true, coversWholeDocument: true })
    await expect(env.service.uploadSigned(secretary, request.id, forged)).rejects.toMatchObject({
      code: "pdf_invalid",
      message: expect.stringMatching(/annotation that is not the signature on page 1/),
    })
    expect((await env.service.getRequest(manager, request.id)).request.signers[0].status).not.toBe("signed")
  })

  for (const inForm of [false, true]) {
    it(`refuses an uploaded signature with an unrelated dummy widget (in form: ${inForm})`, async () => {
      const request = await prepareRequest(env)
      const { currentDocumentId } = await env.service.getRequest(manager, request.id)
      const original = (await env.service.document(secretary, currentDocumentId ?? "")).content
      const doc = await PDFDocument.load(original, { updateMetadata: false })
      const page = doc.getPage(0)
      const n = doc.context.largestObjectNumber + 1
      page.node.set(PDFName.of("Annots"), doc.context.obj([PDFRef.of(n)]))
      const appearance = "q 1 1 1 rg 0 0 150 50 re f Q"
      const objects: Record<number, string> = {
        [page.ref.objectNumber]: page.node.toString(),
        [n]: `<< /Type /Annot /Subtype /Widget /FT /Sig /T (Extra) /V ${n + 1} 0 R /Rect [0 0 150 50] /AP << /N ${n + 2} 0 R >> >>`,
        [n + 1]: "<< /ByteRange [0 0 0 0] >>",
        [n + 2]:
          `<< /Type /XObject /Subtype /Form /BBox [0 0 150 50] /Length ${appearance.length} >>\n` +
          `stream\n${appearance}\nendstream`,
      }
      if (inForm) {
        doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [PDFRef.of(n)] }))
        objects[(doc.context.trailerInfo.Root as PDFRef).objectNumber] = doc.catalog.toString()
      }
      const edited = await appendRevision(original, objects, n + 3)
      const prepared = await prepareSignature(edited, secretarySigner.cert, {
        placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
        fieldName: "Signature1",
        signerName: secretarySigner.name,
        signingTime: new Date(),
        appearance: { lines: [{ text: secretarySigner.name }] },
      })
      const uploaded = finalizeSignature(prepared, await cardSign(secretarySigner, prepared.toBeSigned))
      const check = await inspectPdf(uploaded)
      expect(check.signatures).toHaveLength(1)
      expect(check.signatures[0]).toMatchObject({ intact: true, verified: true, coversWholeDocument: true })
      await expect(env.service.uploadSigned(secretary, request.id, uploaded)).rejects.toMatchObject({
        code: "pdf_invalid",
      })
      const after = await env.service.getRequest(manager, request.id)
      expect(after.currentDocumentId).toBe(currentDocumentId)
      expect(after.request.signers[0].status).toBe("pending")
      expect(after.events.some((event) => event.type === "signed")).toBe(false)
    })
  }

  it("binds the CIE atomically when two prepared signatures use different cards", async () => {
    const first = await prepareRequest(env, false)
    const second = await prepareRequest(env, false)
    const a = await env.service.createJob(secretary, first.id)
    const b = await env.service.createJob(secretary, second.id)
    const prepA = await env.service.agentPrepare(a.ticket, Buffer.from(secretarySigner.cert).toString("base64"), [], 2)
    const prepB = await env.service.agentPrepare(b.ticket, Buffer.from(presidentSigner.cert).toString("base64"), [], 2)
    const sigA = await cardSign(secretarySigner, new Uint8Array(Buffer.from(prepA.toBeSigned, "base64")))
    const sigB = await cardSign(presidentSigner, new Uint8Array(Buffer.from(prepB.toBeSigned, "base64")))
    await env.service.agentComplete(a.ticket, Buffer.from(sigA).toString("base64"))
    await expect(env.service.agentComplete(b.ticket, Buffer.from(sigB).toString("base64"))).rejects.toMatchObject({
      code: "signer_mismatch",
    })
  })

  it("can't cancel a request that just completed, and only managers cancel", async () => {
    const request = await prepareRequest(env, false)
    await expect(env.service.cancelRequest({ ...manager, canManage: false }, request.id)).rejects.toMatchObject({
      code: "forbidden",
    })
    await sign(env, secretary, secretarySigner, request.id)
    await sign(env, president, presidentSigner, request.id)
    await expect(env.service.cancelRequest(manager, request.id)).rejects.toMatchObject({ code: "conflict" })
    await expect(env.service.createJob(president, request.id)).rejects.toThrow("is already signed by everyone")
  })

  it("deletes only a finished request, and only managers delete", async () => {
    const request = await prepareRequest(env, false)
    await expect(env.service.deleteRequest(manager, request.id)).rejects.toMatchObject({ code: "conflict" })
    await sign(env, secretary, secretarySigner, request.id)
    await sign(env, president, presidentSigner, request.id)
    await expect(env.service.deleteRequest({ ...manager, canManage: false }, request.id)).rejects.toMatchObject({
      code: "forbidden",
    })
    await env.service.deleteRequest(manager, request.id)
    await expect(env.service.getRequest(manager, request.id)).rejects.toMatchObject({ code: "not_found" })
    expect(await env.store.listVersions(request.id)).toEqual([])
    expect(await env.store.listEvents(request.id)).toEqual([])
  })

  it("can't delete a request while its delivery is pending", async () => {
    const request = await prepareRequest(env)
    await env.service.cancelRequest(manager, request.id)
    await env.store.updateRequest(request.id, {
      delivery: { status: "pending", driveItem: null, emailedTo: [], error: null, attemptedAt: null },
    })
    await expect(env.service.deleteRequest(manager, request.id)).rejects.toMatchObject({ code: "conflict" })
  })

  it("refuses a revoked CIE and, when required, an unknown status", async () => {
    env = setup({ revocation: "revoked" })
    let request = await prepareRequest(env)
    let job = await env.service.createJob(secretary, request.id)
    await expect(
      env.service.agentPrepare(job.ticket, Buffer.from(secretarySigner.cert).toString("base64"), [], 2)
    ).rejects.toThrow(/revoked/)
    env = setup({ revocation: "unknown", policy: "require" })
    request = await prepareRequest(env)
    job = await env.service.createJob(secretary, request.id)
    await expect(
      env.service.agentPrepare(job.ticket, Buffer.from(secretarySigner.cert).toString("base64"), [], 2)
    ).rejects.toMatchObject({ code: "unavailable" })
    env = setup({ revocation: "unknown" })
    request = await prepareRequest(env)
    const { done } = await sign(env, secretary, secretarySigner, request.id)
    expect(done.status).toBe("completed")
    const { events } = await env.service.getRequest(manager, request.id)
    expect(events.find((e) => e.type === "signed")?.data).toMatchObject({ revocation: "unknown" })
  })

  it("resumes a delivery that a crash left pending", async () => {
    const request = await prepareRequest(env)
    env.mailer.signedDocument.mockRejectedValueOnce(new Error("process died"))
    await sign(env, secretary, secretarySigner, request.id)
    await sign(env, president, presidentSigner, request.id)
    await vi.waitFor(async () =>
      expect((await env.service.getRequest(manager, request.id)).request.delivery?.status).toBe("failed")
    )
    // A failed delivery waits for a manager's retry; a pending one left by a crash is resumed by the sweep.
    await env.store.updateRequest(request.id, {
      delivery: {
        status: "pending",
        driveItem: null,
        emailedTo: [],
        error: null,
        attemptedAt: new Date(0).toISOString(),
      },
    })
    await env.service.sweep()
    expect((await env.service.getRequest(manager, request.id)).request.delivery?.status).toBe("delivered")
  })

  it("delivers once when two managers retry at the same time", async () => {
    const request = await prepareRequest(env)
    env.mailer.signedDocument.mockRejectedValueOnce(new Error("mailbox down"))
    await sign(env, secretary, secretarySigner, request.id)
    await sign(env, president, presidentSigner, request.id)
    await vi.waitFor(async () =>
      expect((await env.service.getRequest(manager, request.id)).request.delivery?.status).toBe("failed")
    )
    env.mailer.signedDocument.mockClear()
    let release: () => void = () => {}
    env.mailer.signedDocument.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(true)
        })
    )
    const first = env.service.retryDelivery(manager, request.id)
    const second = env.service.retryDelivery(manager, request.id).catch((error) => error)
    await vi.waitFor(() => expect(env.mailer.signedDocument).toHaveBeenCalledTimes(1))
    release()
    await first
    await second
    expect(env.mailer.signedDocument).toHaveBeenCalledTimes(1)
  })

  it("refuses an email-only request whose signed PDF would be too large to attach", async () => {
    await env.service.syncProfile(manager, { name: "Luca Verdi", email: null })
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: null })
    await env.service.syncProfile(president, { name: "Anna Bianchi", email: null })
    // A valid PDF just under the attachment cap, with an uncompressible 2 MB stream: it fits under the cap alone, not with two signatures.
    const doc = await PDFDocument.create()
    doc.addPage([595, 842])
    doc.context.register(doc.context.stream(new Uint8Array(randomBytes(2_000_000))))
    const { document } = await env.service.stageUpload(manager, "big.pdf", await doc.save())
    const input = {
      title: "Big",
      documentId: document.id,
      ordered: true,
      signers: [
        { sub: secretary.sub, role: null, places: [{ ...placement(0), kind: "signature" as const }] },
        { sub: president.sub, role: null, places: [{ ...placement(0), kind: "signature" as const }] },
      ],
      email: { to: ["archivio@example.org"], message: null },
    }
    await expect(env.service.createRequest(manager, { ...input, output: null })).rejects.toMatchObject({
      code: "bad_request",
    })
    await expect(
      env.service.createRequest(manager, {
        ...input,
        output: { driveId: "dev", folderId: "mock-firmati", fileName: "big" },
      })
    ).resolves.toMatchObject({ title: "Big" })
  })

  it("reads from and saves to the drive each request names", async () => {
    expect(await env.service.drivesFor(manager)).toEqual([
      { id: "dev", label: "OneDrive (development copy)" },
      { id: "archive", label: "Archive" },
    ])
    await expect(env.service.listDrive(manager, "missing")).rejects.toMatchObject({ code: "not_found" })
    const { document } = await env.service.stageDriveItem(manager, "archive", "mock-verbale-cd")
    expect(document.source).toMatchObject({ kind: "drive", driveId: "archive", itemId: "mock-verbale-cd" })

    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    const base = {
      title: "Verbale",
      documentId: document.id,
      ordered: true,
      signers: [{ sub: secretary.sub, role: null, places: [{ ...placement(0), kind: "signature" as const }] }],
      email: null,
    }
    await expect(
      env.service.createRequest(manager, {
        ...base,
        output: { driveId: "missing", folderId: "mock-firmati", fileName: "x" },
      })
    ).rejects.toMatchObject({ code: "not_found" })
    const request = await env.service.createRequest(manager, {
      ...base,
      output: { driveId: "archive", folderId: "mock-firmati", fileName: "Verbale firmato" },
    })
    await sign(env, secretary, secretarySigner, request.id)
    await vi.waitFor(async () => {
      const { request: done } = await env.service.getRequest(manager, request.id)
      expect(done.delivery?.status).toBe("delivered")
    })
    const names = async (drive: typeof env.drive) => (await drive.list("mock-firmati")).items.map((i) => i.name)
    expect(await names(env.archive)).toEqual(["Verbale firmato.pdf"])
    expect(await names(env.drive)).toEqual([])
  })

  it("signs one signer's several places with one PDF signature per full signature and marks drawn by the first", async () => {
    await env.service.syncProfile(manager, { name: "Luca Verdi", email: "luca@example.org" })
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    const { document } = await env.service.stageUpload(manager, "verbale.pdf", await samplePdf())
    const request = await env.service.createRequest(manager, {
      title: "Contratto",
      documentId: document.id,
      ordered: true,
      signers: [
        {
          sub: secretary.sub,
          role: null,
          places: [
            { ...placement(0), kind: "signature" },
            { ...placement(1), kind: "mark" },
            { ...placement(1), y: 0.1, kind: "signature" },
          ],
        },
      ],
      output: null,
      email: null,
    })
    const { ticket } = await env.service.createJob(secretary, request.id)
    expect(await env.service.agentJob(ticket)).toMatchObject({ signatures: 2, marks: 1, pages: [0, 1] })
    expect(await signJob(env, secretarySigner, ticket)).toEqual(["next", "completed"])

    const { request: done, versions, events, currentDocumentId } = await env.service.getRequest(manager, request.id)
    expect(done.status).toBe("completed")
    expect(done.signers[0]).toMatchObject({ status: "signed", signaturesDone: 2 })
    expect(versions.map((v) => v.version)).toEqual([0, 1, 2])
    expect(events.filter((e) => e.type === "signed")).toHaveLength(1)
    const { content } = await env.service.document(manager, currentDocumentId ?? "")
    const pdf = await inspectPdf(content)
    expect(pdf.signatures.map((s) => [s.signerName, s.intact && s.verified])).toEqual([
      ["Mario Rossi", true],
      ["Mario Rossi", true],
    ])
    expect(pdf.signatures.at(-1)?.coversWholeDocument).toBe(true)
    expect(await stampsOn(content, 1)).toBe(1)
    expect(await stampsOn(content, 0)).toBe(0)
  })

  it("resumes an interrupted signer at the place still to sign", async () => {
    await env.service.syncProfile(manager, { name: "Luca Verdi", email: "luca@example.org" })
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    const { document } = await env.service.stageUpload(manager, "verbale.pdf", await samplePdf())
    const places = [
      { ...placement(0), kind: "signature" as const },
      { ...placement(1), kind: "signature" as const },
    ]
    const request = await env.service.createRequest(manager, {
      title: "Contratto",
      documentId: document.id,
      ordered: true,
      signers: [{ sub: secretary.sub, role: null, places }],
      output: null,
      email: null,
    })
    const first = await env.service.createJob(secretary, request.id)
    const { toBeSigned } = await env.service.agentPrepare(
      first.ticket,
      Buffer.from(secretarySigner.cert).toString("base64"),
      [],
      2
    )
    const signature = await cardSign(secretarySigner, new Uint8Array(Buffer.from(toBeSigned, "base64")))
    expect((await env.service.agentComplete(first.ticket, Buffer.from(signature).toString("base64"))).status).toBe(
      "next"
    )
    // The card left the reader: the dashboard starts again, and moved boxes no longer apply.
    const moved = places.map((p) => ({ ...p, x: 0.5 }))
    const again = await env.service.createJob(secretary, request.id, moved)
    expect(await env.service.agentJob(again.ticket)).toMatchObject({ signatures: 1, marks: 0, placement: { page: 1 } })
    expect(await signJob(env, secretarySigner, again.ticket)).toEqual(["completed"])
    const { request: done } = await env.service.getRequest(manager, request.id)
    expect(done.signers[0].places.map((p) => p.x)).toEqual([0.1, 0.1])
  })

  it("moves the boxes the signer dragged before signing, keeping their kinds", async () => {
    const request = await prepareRequest(env)
    await expect(env.service.createJob(secretary, request.id, [placement(0), placement(1)])).rejects.toMatchObject({
      code: "bad_request",
    })
    await env.service.createJob(secretary, request.id, [{ ...placement(1), x: 0.4 }])
    const { request: detail } = await env.service.getRequest(manager, request.id)
    expect(detail.signers[0].places).toEqual([{ ...placement(1), x: 0.4, kind: "signature" }])
  })

  it("needs a full signature for each signer", async () => {
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    const { document } = await env.service.stageUpload(manager, "verbale.pdf", await samplePdf())
    await expect(
      env.service.createRequest(manager, {
        title: "Solo sigla",
        documentId: document.id,
        ordered: true,
        signers: [{ sub: secretary.sub, role: null, places: [{ ...placement(0), kind: "mark" }] }],
        output: null,
        email: null,
      })
    ).rejects.toMatchObject({ code: "bad_request" })
  })

  it("starts a batch whole or not at all, and signs each document of it", async () => {
    const first = await prepareRequest(env)
    const second = await prepareRequest(env)
    const notYet = await prepareRequest(env)
    await sign(env, secretary, secretarySigner, notYet.id)
    await expect(
      env.service.createJobs(president, [{ requestId: first.id }, { requestId: notYet.id }])
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(await env.store.openJobs(notYet.id)).toHaveLength(0)

    const jobs = await env.service.createJobs(secretary, [{ requestId: first.id }, { requestId: second.id }])
    expect(jobs.map((j) => j.requestId)).toEqual([first.id, second.id])
    for (const job of jobs) await signJob(env, secretarySigner, job.ticket)
    const statuses = await env.service.jobStatuses(
      secretary,
      jobs.map((j) => j.jobId)
    )
    expect(statuses.map((s) => [s.status, s.signaturesLeft])).toEqual([
      ["completed", 0],
      ["completed", 0],
    ])
    await expect(
      env.service.createJobs(secretary, [{ requestId: first.id }, { requestId: first.id }])
    ).rejects.toMatchObject({
      code: "bad_request",
    })
  })

  it("asks an outdated agent to update before it signs, ending the job", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    await expect(
      env.service.agentPrepare(ticket, Buffer.from(secretarySigner.cert).toString("base64"))
    ).rejects.toMatchObject({ code: "agent_outdated" })
    expect((await env.service.jobStatuses(secretary, [jobId]))[0]).toMatchObject({
      status: "failed",
      errorCode: "agent_outdated",
    })
  })

  it("restricts each drive to the roles and permissions its rule names", async () => {
    const boardOnly = { roles: ["direttivo"], permissions: [] }
    const admin: Caller = { ...manager, canManageDrives: true }
    await expect(
      env.service.setDriveAccess(manager, "archive", { request: boardOnly, sign: boardOnly })
    ).rejects.toMatchObject({ code: "forbidden" })
    await env.service.setDriveAccess(admin, "archive", { request: boardOnly, sign: boardOnly })
    expect((await env.service.driveAccess(admin)).drives.find((d) => d.id === "archive")).toMatchObject({
      request: boardOnly,
      sign: boardOnly,
    })

    // Without the role the manager sees only the other drive, and can't use the restricted one.
    expect((await env.service.drivesFor(manager)).map((d) => d.id)).toEqual(["dev"])
    await expect(env.service.listDrive(manager, "archive")).rejects.toMatchObject({ code: "forbidden" })
    await expect(env.service.stageDriveItem(manager, "archive", "mock-verbale-cd")).rejects.toMatchObject({
      code: "forbidden",
    })

    env.people.set(manager.sub, { roles: ["direttivo"], permissions: ["esign:requests:manage"] })
    env.people.set(president.sub, { roles: ["direttivo"], permissions: ["esign:sign"] })
    expect((await env.service.drivesFor(manager)).map((d) => d.id)).toEqual(["dev", "archive"])
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    await env.service.syncProfile(president, { name: "Anna Bianchi", email: "anna@example.org" })
    expect(
      (await env.service.listProfiles())
        .map((p) => [p.sub, p.drives])
        .sort(([a], [b]) => String(a).localeCompare(String(b)))
    ).toEqual([
      [president.sub, ["dev", "archive"]],
      [secretary.sub, ["dev"]],
    ])

    // Only people allowed on the drive can be asked to sign its documents.
    const { document } = await env.service.stageDriveItem(manager, "archive", "mock-verbale-cd")
    const base = {
      title: "Verbale",
      documentId: document.id,
      ordered: true,
      output: null,
      email: null,
    }
    await expect(
      env.service.createRequest(manager, {
        ...base,
        signers: [{ sub: secretary.sub, role: null, places: [{ ...placement(0), kind: "signature" }] }],
      })
    ).rejects.toThrow("Mario Rossi can't sign documents of Archive")
    const request = await env.service.createRequest(manager, {
      ...base,
      signers: [{ sub: president.sub, role: null, places: [{ ...placement(0), kind: "signature" }] }],
    })
    expect(request.drives).toEqual(["archive"])

    // Other managers don't see the drive's requests; its creator and signers do.
    const other: Caller = { sub: "sub-other-manager", canManage: true }
    expect(await env.service.listRequests(other, "all")).toHaveLength(0)
    await expect(env.service.getRequest(other, request.id)).rejects.toMatchObject({ code: "not_found" })
    expect(await env.service.listRequests(manager, "all")).toHaveLength(1)
    expect(await env.service.listRequests(president, "inbox")).toHaveLength(1)

    // A signer who loses access can't sign any more, and is told so instead of seeing their turn.
    env.people.set(president.sub, { roles: [], permissions: ["esign:sign"] })
    expect(await env.service.listRequests(president, "inbox")).toHaveLength(0)
    expect(await env.service.listRequests(president, "mine")).toHaveLength(1)
    const { request: stranded } = await env.service.getRequest(president, request.id)
    expect(stranded.myTurn).toBe(false)
    expect(stranded.turn).toEqual([president.sub])
    expect(stranded.signers[0].lostAccess).toBe("Archive")
    await expect(env.service.createJob(president, request.id)).rejects.toThrow(/no longer sign documents of Archive/)

    // Clearing the rule restores the default.
    await env.service.setDriveAccess(admin, "archive", {
      request: { roles: [], permissions: [] },
      sign: { roles: [], permissions: [] },
    })
    expect((await env.service.drivesFor(other)).map((d) => d.id)).toEqual(["dev", "archive"])
    expect((await env.service.getRequest(president, request.id)).request.signers[0].lostAccess).toBeNull()
    await expect(env.service.createJob(president, request.id)).resolves.toMatchObject({ ticket: expect.any(String) })
  })

  it("lists the requests in progress that a narrower sign rule would strand", async () => {
    const admin: Caller = { ...manager, canManageDrives: true }
    const boardOnly = { roles: ["direttivo"], permissions: [] }
    env.people.set(president.sub, { roles: ["direttivo"], permissions: ["esign:sign"] })
    env.people.set(secretary.sub, { roles: [], permissions: ["esign:sign"] })
    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    await env.service.syncProfile(president, { name: "Anna Bianchi", email: "anna@example.org" })
    const { document } = await env.service.stageDriveItem(manager, "archive", "mock-verbale-cd")
    // The secretary signs second: a later signer of an ordered request is stranded too.
    const request = await env.service.createRequest(manager, {
      title: "Verbale",
      documentId: document.id,
      ordered: true,
      signers: [
        { sub: president.sub, role: null, places: [{ ...placement(0), kind: "signature" }] },
        { sub: secretary.sub, role: null, places: [{ ...placement(1), kind: "signature" }] },
      ],
      output: null,
      email: null,
    })

    expect(await env.service.driveAccessImpact(admin, "archive", boardOnly)).toEqual([
      { id: request.id, title: "Verbale", signers: ["Mario Rossi"] },
    ])
    expect(await env.service.driveAccessImpact(admin, "dev", boardOnly)).toEqual([])
    expect(await env.service.driveAccessImpact(admin, "archive", { roles: [], permissions: [] })).toEqual([])
    await env.service.setDriveAccess(admin, "archive", { request: { roles: [], permissions: [] }, sign: boardOnly })
    expect(await env.service.driveAccessImpact(admin, "archive", boardOnly)).toEqual([])
    expect(
      await env.service.driveAccessImpact(admin, "archive", { roles: ["direttivo", "socio"], permissions: [] })
    ).toEqual([])
    await expect(env.service.driveAccessImpact(manager, "archive", boardOnly)).rejects.toMatchObject({
      code: "forbidden",
    })
  })

  it("matches a rule by permission as well as by role", async () => {
    const admin: Caller = { ...manager, canManageDrives: true }
    await env.service.setDriveAccess(admin, "archive", {
      request: { roles: ["direttivo"], permissions: ["esign:archive"] },
      sign: { roles: [], permissions: [] },
    })
    env.people.set(manager.sub, { roles: [], permissions: ["esign:archive"] })
    expect((await env.service.drivesFor(manager)).map((d) => d.id)).toEqual(["dev", "archive"])
    expect((await env.service.drivesFor({ sub: "nobody", canManage: true })).map((d) => d.id)).toEqual(["dev"])
    expect(await env.service.drivesFor({ sub: manager.sub, canManage: false })).toEqual([])
  })

  it("lets a signer decline", async () => {
    const request = await prepareRequest(env)
    await env.service.declineRequest(secretary, request.id, "Errore nel testo")
    const { request: declined } = await env.service.getRequest(manager, request.id)
    expect(declined.status).toBe("declined")
    expect(declined.signers[0]).toMatchObject({ status: "declined", declineReason: "Errore nel testo" })
  })

  it("reads a document's bytes for its pages and signatures only when they weren't inspected yet", async () => {
    const request = await prepareRequest(env)
    const documentId = (await env.service.getRequest(manager, request.id)).currentDocumentId ?? ""
    const getDocument = vi.spyOn(env.store, "getDocument")
    // The upload inspected it.
    const { meta, pdf } = await env.service.documentInfo(secretary, documentId)
    expect(meta).toMatchObject({ id: documentId, fileName: "verbale.pdf", version: 0, pages: 2 })
    expect(meta).not.toHaveProperty("content")
    expect(pdf.pages).toHaveLength(2)
    expect(getDocument).not.toHaveBeenCalled()
    // A replica reads and inspects it once.
    const replica = setup({ store: env.store })
    await expect(replica.service.documentInfo(secretary, documentId)).resolves.toEqual({ meta, pdf })
    await replica.service.documentInfo(president, documentId)
    expect(getDocument).toHaveBeenCalledTimes(1)
    const stranger: Caller = { sub: "sub-stranger", canManage: false }
    await expect(replica.service.documentInfo(stranger, documentId)).rejects.toMatchObject({ code: "not_found" })
    await expect(env.service.document(stranger, documentId)).rejects.toMatchObject({ code: "not_found" })
    const { meta: same, content } = await env.service.document(secretary, documentId)
    expect(same).toEqual(meta)
    expect(content).toHaveLength(meta.size)
    // A staged upload is its creator's and the managers'.
    const { document: staged } = await env.service.stageUpload(manager, "bozza.pdf", await samplePdf(1))
    expect((await env.service.documentInfo(manager, staged.id)).pdf.pages).toHaveLength(1)
    await expect(env.service.documentInfo(secretary, staged.id)).rejects.toMatchObject({ code: "not_found" })
  })

  it("hides requests from people who are not involved", async () => {
    const request = await prepareRequest(env)
    const stranger: Caller = { sub: "sub-stranger", canManage: false }
    await expect(env.service.getRequest(stranger, request.id)).rejects.toBeInstanceOf(EsignError)
    expect(await env.service.listRequests(stranger, "mine")).toHaveLength(0)
    await expect(env.service.listRequests(stranger, "all")).rejects.toMatchObject({ code: "forbidden" })
  })

  describe("inbox", () => {
    const pdf = samplePdf()

    beforeEach(async () => {
      await env.service.syncProfile(manager, { name: "Luca Verdi", email: "luca@example.org" })
      await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
      await env.service.syncProfile(president, { name: "Anna Bianchi", email: "anna@example.org" })
    })

    async function request(ordered: boolean, order: Caller[]) {
      const { document } = await env.service.stageUpload(manager, "verbale.pdf", await pdf)
      return env.service.createRequest(manager, {
        title: "Verbale",
        documentId: document.id,
        ordered,
        signers: order.map((c, i) => ({
          sub: c.sub,
          role: `ruolo ${i}`,
          places: [{ ...placement(0), kind: "signature" as const }],
        })),
        output: { driveId: "dev", folderId: "mock-firmati", fileName: "Verbale firmato" },
        email: { to: [], message: "" },
      })
    }

    async function markSigned(requestId: string, caller: Caller) {
      const stored = await env.store.getRequest(requestId)
      const signer = stored?.signers.find((s) => s.sub === caller.sub)
      if (!signer) throw new Error("no such signer")
      await env.store.updateSigner(signer.id, { status: "signed" })
    }

    const ids = async (caller: Caller) => (await env.service.listRequests(caller, "inbox")).map((r) => r.id).sort()

    it("is not hidden behind more than 200 newer requests awaiting someone else", async () => {
      const actionable = await request(true, [secretary, president])
      await new Promise((resolve) => setTimeout(resolve, 5))
      for (let i = 0; i < 110; i++) await request(true, [president, secretary])
      for (let i = 0; i < 110; i++) {
        const r = await request(false, [secretary, president])
        await markSigned(r.id, secretary)
      }

      const inbox = await env.service.listRequests(secretary, "inbox")
      expect(inbox.map((r) => r.id)).toEqual([actionable.id])
      expect(inbox[0]?.myTurn).toBe(true)
      expect(await env.service.listRequests(president, "inbox")).toHaveLength(200)
      expect(await ids(president)).not.toContain(actionable.id)
      // The creator is involved in every request but signs none of them.
      expect(await env.service.listRequests(manager, "inbox")).toHaveLength(0)
      expect(await env.service.listRequests(secretary, "mine")).toHaveLength(200)
    })

    it("follows the turn of ordered and unordered requests", async () => {
      const ordered = await request(true, [secretary, president])
      const unordered = await request(false, [secretary, president])
      const cancelled = await request(false, [secretary, president])
      await env.service.cancelRequest(manager, cancelled.id)
      const stranger: Caller = { sub: "sub-stranger", canManage: true }

      expect(await ids(secretary)).toEqual([ordered.id, unordered.id].sort())
      expect(await ids(president)).toEqual([unordered.id])
      expect(await ids(stranger)).toEqual([])

      await markSigned(ordered.id, secretary)
      await markSigned(unordered.id, secretary)
      expect(await ids(secretary)).toEqual([])
      expect(await ids(president)).toEqual([ordered.id, unordered.id].sort())
    })
  })
})
