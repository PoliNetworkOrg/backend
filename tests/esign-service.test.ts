import { randomBytes, X509Certificate } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMockDrive } from "@/esign/drive/mock"
import { EsignError } from "@/esign/errors"
import { dataToBeSigned, sha256, signedAttributes } from "@/esign/pdf/cms"
import { signedBytes } from "@/esign/pdf/incremental"
import { inspectPdf } from "@/esign/pdf/inspect"
import { finalizeSignature, prepareSignature } from "@/esign/pdf/pades"
import { type Caller, createEsignService, type Mailer } from "@/esign/service"
import { createMemoryStore } from "@/esign/store-memory"
import { cardSign, createTestCa, samplePdf, type TestSigner } from "./esign-fixtures"

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
  } = {}
) {
  let clock = new Date("2026-10-17T10:00:00Z").getTime()
  const store = createMemoryStore()
  const drive = createMockDrive()
  const archive = createMockDrive({ id: "archive", label: "Archive" })
  const mailer = {
    signatureRequest: vi.fn<Mailer["signatureRequest"]>().mockResolvedValue(true),
    signedDocument: vi.fn<Mailer["signedDocument"]>().mockResolvedValue(true),
  }
  const service = createEsignService({
    store,
    drives: [drive, archive],
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
  return { service, store, drive, archive, mailer, advance }
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
      { sub: secretary.sub, role: "segretario", placement: placement(0) },
      { sub: president.sub, role: "presidente", placement: placement(1) },
    ],
    output: { driveId: "dev", folderId: "mock-firmati", fileName: "Verbale CD firmato" },
    email: { to: ["archivio@example.org"], message: "In allegato il verbale." },
  })
}

async function sign(env: ReturnType<typeof setup>, caller: Caller, signer: TestSigner, requestId: string) {
  const { ticket } = await env.service.createJob(caller, requestId)
  const job = await env.service.agentJob(ticket)
  const { toBeSigned } = await env.service.agentPrepare(ticket, Buffer.from(signer.cert).toString("base64"))
  const signature = await cardSign(signer, new Uint8Array(Buffer.from(toBeSigned, "base64")))
  const done = await env.service.agentComplete(ticket, Buffer.from(signature).toString("base64"))
  return { job, done, ticket }
}

describe("e-signing service", () => {
  let env: ReturnType<typeof setup>
  beforeEach(() => {
    env = setup()
  })

  it("collects signatures in order, then uploads and emails the signed PDF", async () => {
    const request = await prepareRequest(env)
    expect(request.turn).toEqual([secretary.sub])
    expect(env.mailer.signatureRequest).toHaveBeenCalledWith(
      "mario@example.org",
      expect.objectContaining({ role: "segretario" })
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

  it("binds a signer to the CIE of their first signature", async () => {
    const request = await prepareRequest(env, false)
    await sign(env, secretary, secretarySigner, request.id)
    const other = await prepareRequest(env, false)
    const { ticket } = await env.service.createJob(secretary, other.id)
    await expect(
      env.service.agentPrepare(ticket, Buffer.from(presidentSigner.cert).toString("base64"))
    ).rejects.toMatchObject({ code: "signer_mismatch" })
  })

  it("lets one signer at a time sign an unordered request", async () => {
    const request = await prepareRequest(env, false)
    expect(request.turn).toEqual([secretary.sub, president.sub])
    await env.service.createJob(secretary, request.id)
    await expect(env.service.createJob(president, request.id)).rejects.toThrow(/Mario Rossi is signing/)
    env.advance(11 * 60 * 1000)
    await expect(env.service.createJob(president, request.id)).resolves.toMatchObject({ ticket: expect.any(String) })
  })

  it("expires tickets and refuses a stale document", async () => {
    const request = await prepareRequest(env, false)
    const { ticket } = await env.service.createJob(secretary, request.id)
    await env.service.agentPrepare(ticket, Buffer.from(secretarySigner.cert).toString("base64"))
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
      env.service.agentPrepare(ticket, Buffer.from(secretarySigner.cert).toString("base64"))
    ).rejects.toMatchObject({ code: "certificate_invalid" })
  })

  it("cancels open signatures with the request", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    await env.service.cancelRequest(manager, request.id)
    await expect(env.service.agentJob(ticket)).rejects.toMatchObject({ code: "job_cancelled" })
    expect((await env.service.jobStatus(secretary, jobId)).status).toBe("cancelled")
  })

  it("records agent failures without ending the job", async () => {
    const request = await prepareRequest(env)
    const { ticket, jobId } = await env.service.createJob(secretary, request.id)
    expect((await env.service.jobStatus(secretary, jobId)).seen).toBe(false)
    await env.service.agentJob(ticket)
    await env.service.agentFail(ticket, "pin_incorrect", "Wrong PIN.")
    expect(await env.service.jobStatus(secretary, jobId)).toMatchObject({
      status: "pending",
      errorCode: "pin_incorrect",
      seen: true,
    })
    await env.service.agentFail(ticket, "cancelled", null)
    expect((await env.service.jobStatus(secretary, jobId)).status).toBe("cancelled")
  })

  it("accepts a PDF signed with the official CIE app as a fallback", async () => {
    const request = await prepareRequest(env)
    const { request: detail, currentDocumentId } = await env.service.getRequest(manager, request.id)
    const original = (await env.service.document(secretary, currentDocumentId ?? "")).content
    // What Software CIE would produce: the same bytes plus one incremental signature.
    async function externallySigned(signer: TestSigner) {
      const prepared = await prepareSignature(original, signer.cert, {
        placement: { page: 0, x: 0.1, y: 0.1, width: 0.3, height: 0.1 },
        fieldName: "Signature1",
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
    const entry = `[${range.join(" ")}`.padEnd(match[1].length - 1, " ") + "]"
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
  })

  it("binds the CIE atomically when two prepared signatures use different cards", async () => {
    const first = await prepareRequest(env, false)
    const second = await prepareRequest(env, false)
    const a = await env.service.createJob(secretary, first.id)
    const b = await env.service.createJob(secretary, second.id)
    const prepA = await env.service.agentPrepare(a.ticket, Buffer.from(secretarySigner.cert).toString("base64"))
    const prepB = await env.service.agentPrepare(b.ticket, Buffer.from(presidentSigner.cert).toString("base64"))
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
  })

  it("refuses a revoked CIE and, when required, an unknown status", async () => {
    env = setup({ revocation: "revoked" })
    let request = await prepareRequest(env)
    let job = await env.service.createJob(secretary, request.id)
    await expect(
      env.service.agentPrepare(job.ticket, Buffer.from(secretarySigner.cert).toString("base64"))
    ).rejects.toThrow(/revoked/)
    env = setup({ revocation: "unknown", policy: "require" })
    request = await prepareRequest(env)
    job = await env.service.createJob(secretary, request.id)
    await expect(
      env.service.agentPrepare(job.ticket, Buffer.from(secretarySigner.cert).toString("base64"))
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
        { sub: secretary.sub, role: null, placement: placement(0) },
        { sub: president.sub, role: null, placement: placement(0) },
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
    expect(env.service.drives).toEqual([
      { id: "dev", label: "OneDrive (development copy)" },
      { id: "archive", label: "Archive" },
    ])
    await expect(env.service.listDrive("missing")).rejects.toMatchObject({ code: "not_found" })
    const { document } = await env.service.stageDriveItem(manager, "archive", "mock-verbale-cd")
    expect(document.source).toMatchObject({ kind: "drive", driveId: "archive", itemId: "mock-verbale-cd" })

    await env.service.syncProfile(secretary, { name: "Mario Rossi", email: "mario@example.org" })
    const base = {
      title: "Verbale",
      documentId: document.id,
      ordered: true,
      signers: [{ sub: secretary.sub, role: null, placement: placement(0) }],
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

  it("lets a signer decline", async () => {
    const request = await prepareRequest(env)
    await env.service.declineRequest(secretary, request.id, "Errore nel testo")
    const { request: declined } = await env.service.getRequest(manager, request.id)
    expect(declined.status).toBe("declined")
    expect(declined.signers[0]).toMatchObject({ status: "declined", declineReason: "Errore nel testo" })
  })

  it("hides requests from people who are not involved", async () => {
    const request = await prepareRequest(env)
    const stranger: Caller = { sub: "sub-stranger", canManage: false }
    await expect(env.service.getRequest(stranger, request.id)).rejects.toBeInstanceOf(EsignError)
    expect(await env.service.listRequests(stranger, "mine")).toHaveLength(0)
    await expect(env.service.listRequests(stranger, "all")).rejects.toMatchObject({ code: "forbidden" })
  })
})
