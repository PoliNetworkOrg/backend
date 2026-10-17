import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMockDrive } from "@/esign/drive/mock"
import { EsignError } from "@/esign/errors"
import { inspectPdf } from "@/esign/pdf/inspect"
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

function setup(opts: { allowTestCertificates?: boolean } = {}) {
  let clock = new Date("2026-10-17T10:00:00Z").getTime()
  const store = createMemoryStore()
  const drive = createMockDrive()
  const mailer = {
    signatureRequest: vi.fn<Mailer["signatureRequest"]>().mockResolvedValue(true),
    signedDocument: vi.fn<Mailer["signedDocument"]>().mockResolvedValue(true),
  }
  const service = createEsignService({
    store,
    drive,
    mailer,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dashboardUrl: "https://admin.example.org",
    allowTestCertificates: opts.allowTestCertificates ?? true,
    now: () => new Date(clock),
  })
  return { service, store, drive, mailer, advance: (ms: number) => (clock += ms) }
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
    output: { folderId: "mock-firmati", fileName: "Verbale CD firmato" },
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
