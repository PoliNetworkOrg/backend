import type { Actor } from "@polinetwork/auth-kit"
import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { env } from "@/env"
import { esign } from "@/esign"
import { MAX_PDF_BYTES } from "@/esign/drive/types"
import { EsignError, type EsignErrorCode } from "@/esign/errors"
import type { PdfInfo } from "@/esign/pdf/inspect"
import { MAX_PLACES } from "@/esign/placement"
import type { Caller } from "@/esign/service"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

/** Using e-signing at all; managing requests is checked on top where needed. */
const SIGN = "esign:sign"
const MANAGE = "esign:requests:manage"
/** Who may use each drive. */
const MANAGE_DRIVES = "esign:drives:manage"

/** The dashboard's agent-mode user, on the legacy anonymous path in development only. */
const DEV_SUB = "agent-preview-user"

const TRPC_CODE: Record<EsignErrorCode, TRPCError["code"]> = {
  not_found: "NOT_FOUND",
  forbidden: "FORBIDDEN",
  bad_request: "BAD_REQUEST",
  conflict: "CONFLICT",
  unavailable: "PRECONDITION_FAILED",
  pdf_invalid: "BAD_REQUEST",
  ticket_invalid: "NOT_FOUND",
  job_expired: "CONFLICT",
  job_done: "CONFLICT",
  job_cancelled: "CONFLICT",
  document_changed: "CONFLICT",
  certificate_invalid: "BAD_REQUEST",
  signer_mismatch: "FORBIDDEN",
  signature_invalid: "BAD_REQUEST",
  agent_outdated: "PRECONDITION_FAILED",
}

function callerOf(ctx: { actor: Actor | null; can: (permission: string) => boolean }): Caller {
  if (ctx.actor?.kind === "user")
    return { sub: ctx.actor.sub, canManage: ctx.can(MANAGE), canManageDrives: ctx.can(MANAGE_DRIVES) }
  if (ctx.actor === null && env.NODE_ENV === "development")
    return { sub: DEV_SUB, canManage: true, canManageDrives: true }
  throw new TRPCError({ code: "FORBIDDEN", message: "Only dashboard users can sign" })
}

/** Runs a service call, turning its expected failures into tRPC errors with the same message. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof EsignError)
      throw new TRPCError({ code: TRPC_CODE[error.code], message: error.message, cause: error })
    throw error
  }
}

const user = policy(dashboard(SIGN))

const placement = z.object({
  page: z.number().int().min(0),
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
})

/** What clients see of a PDF: pages, signatures and field names, never the certificate objects. */
function publicPdf(pdf: PdfInfo) {
  return { pages: pdf.pages, signatures: pdf.signatures, fieldNames: pdf.fieldNames }
}

const accessKey = z.string().regex(/^[A-Za-z0-9:._-]{1,100}$/)
const driveRule = z.object({ roles: z.array(accessKey).max(50), permissions: z.array(accessKey).max(50) })

function requireManage(caller: Caller) {
  if (!caller.canManage) throw new TRPCError({ code: "FORBIDDEN", message: "You cannot manage signature requests" })
}

export const esignRouter = createTRPCRouter({
  /** What the dashboard can offer: the configured drives (none without OneDrive) and whether the caller manages requests. */
  config: user.query(async ({ ctx }) => {
    const caller = callerOf(ctx)
    return { drives: await esign.drivesFor(caller), canManage: caller.canManage, maxPdfBytes: MAX_PDF_BYTES }
  }),

  profile: createTRPCRouter({
    /** The BFF passes the signed-in user's name and email from the ID token. */
    sync: user
      .input(z.object({ name: z.string().min(1).max(200), email: z.email().nullable() }))
      .mutation(({ ctx, input }) => run(() => esign.syncProfile(callerOf(ctx), input))),
  }),

  signers: createTRPCRouter({
    list: user.query(({ ctx }) => {
      requireManage(callerOf(ctx))
      return run(() => esign.listProfiles())
    }),
    /** Forgets the CIE bound to a person, e.g. after they renewed their card. */
    resetIdentity: user.input(z.object({ sub: z.string().min(1) })).mutation(({ ctx, input }) => {
      requireManage(callerOf(ctx))
      return run(() => esign.resetIdentity(input.sub))
    }),
  }),

  drive: createTRPCRouter({
    list: user
      .input(z.object({ driveId: z.string().min(1), folderId: z.string().min(1).optional() }))
      .query(({ ctx, input }) => {
        requireManage(callerOf(ctx))
        return run(() => esign.listDrive(callerOf(ctx), input.driveId, input.folderId))
      }),
    /** Every drive's access rules and the roles and permissions they can name. */
    access: user.query(({ ctx }) => run(() => esign.driveAccess(callerOf(ctx)))),
    setAccess: user
      .input(z.object({ driveId: z.string().min(1), request: driveRule, sign: driveRule }))
      .mutation(({ ctx, input }) =>
        run(() => esign.setDriveAccess(callerOf(ctx), input.driveId, { request: input.request, sign: input.sign }))
      ),
  }),

  documents: createTRPCRouter({
    upload: user
      .input(
        z
          .instanceof(FormData)
          .transform((fd) => fd.get("file"))
          .pipe(z.instanceof(File).refine((f) => f.size <= MAX_PDF_BYTES, "The PDF is larger than 30 MB"))
      )
      .mutation(async ({ ctx, input }) => {
        const caller = callerOf(ctx)
        requireManage(caller)
        const { document, pdf } = await run(async () =>
          esign.stageUpload(caller, input.name, new Uint8Array(await input.arrayBuffer()))
        )
        return { document, pdf: publicPdf(pdf) }
      }),
    fromDrive: user
      .input(z.object({ driveId: z.string().min(1), itemId: z.string().min(1) }))
      .mutation(async ({ ctx, input }) => {
        const caller = callerOf(ctx)
        requireManage(caller)
        const { document, pdf } = await run(() => esign.stageDriveItem(caller, input.driveId, input.itemId))
        return { document, pdf: publicPdf(pdf) }
      }),
    /** The document's metadata, pages and existing signatures. */
    get: user.input(z.object({ documentId: z.uuid() })).query(async ({ ctx, input }) => {
      const { meta, pdf } = await run(() => esign.document(callerOf(ctx), input.documentId))
      return { document: meta, pdf: publicPdf(pdf) }
    }),
    /** The PDF itself, base64-encoded. */
    content: user.input(z.object({ documentId: z.uuid() })).query(async ({ ctx, input }) => {
      const { meta, content } = await run(() => esign.document(callerOf(ctx), input.documentId))
      return { fileName: meta.fileName, base64: Buffer.from(content).toString("base64") }
    }),
  }),

  requests: createTRPCRouter({
    create: user
      .input(
        z.object({
          title: z.string().trim().min(1).max(200),
          documentId: z.uuid(),
          ordered: z.boolean(),
          signers: z
            .array(
              z.object({
                sub: z.string().min(1),
                role: z.string().trim().max(80).nullable(),
                places: z
                  .array(placement.extend({ kind: z.enum(["signature", "mark"]) }))
                  .min(1)
                  .max(MAX_PLACES),
              })
            )
            .min(1)
            .max(10),
          output: z
            .object({
              driveId: z.string().min(1),
              folderId: z.string().min(1),
              fileName: z.string().trim().min(1).max(200),
            })
            .nullable(),
          email: z.object({ to: z.array(z.email()).max(20), message: z.string().max(2000).nullable() }).nullable(),
        })
      )
      .mutation(({ ctx, input }) => run(() => esign.createRequest(callerOf(ctx), input))),
    list: user
      .input(z.object({ scope: z.enum(["inbox", "mine", "all"]) }))
      .query(({ ctx, input }) => run(() => esign.listRequests(callerOf(ctx), input.scope))),
    get: user
      .input(z.object({ id: z.uuid() }))
      .query(({ ctx, input }) => run(() => esign.getRequest(callerOf(ctx), input.id))),
    cancel: user
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => run(() => esign.cancelRequest(callerOf(ctx), input.id))),
    decline: user
      .input(z.object({ id: z.uuid(), reason: z.string().max(500).nullable() }))
      .mutation(({ ctx, input }) => run(() => esign.declineRequest(callerOf(ctx), input.id, input.reason))),
    /** The fallback: a PDF signed with the official CIE app, uploaded by its signer. */
    uploadSigned: user
      .input(
        z
          .instanceof(FormData)
          .transform((fd) => ({ requestId: fd.get("requestId"), file: fd.get("file") }))
          .pipe(
            z.object({
              requestId: z.uuid(),
              file: z.instanceof(File).refine((f) => f.size <= MAX_PDF_BYTES, "The PDF is larger than 30 MB"),
            })
          )
      )
      .mutation(({ ctx, input }) =>
        run(async () =>
          esign.uploadSigned(callerOf(ctx), input.requestId, new Uint8Array(await input.file.arrayBuffer()))
        )
      ),
    retryDelivery: user
      .input(z.object({ id: z.uuid() }))
      .mutation(({ ctx, input }) => run(() => esign.retryDelivery(callerOf(ctx), input.id))),
  }),

  jobs: createTRPCRouter({
    /**
     * Starts the caller's signatures of one or more requests; the dashboard opens the agent's page with every returned
     * ticket, so one PIN signs them all. `places` moves the caller's boxes before signing, one per place, in order.
     */
    create: user
      .input(
        z.object({
          items: z
            .array(z.object({ requestId: z.uuid(), places: z.array(placement).max(MAX_PLACES).optional() }))
            .min(1)
            .max(10),
        })
      )
      .mutation(({ ctx, input }) => run(() => esign.createJobs(callerOf(ctx), input.items))),
    statuses: user
      .input(z.object({ jobIds: z.array(z.uuid()).min(1).max(10) }))
      .query(({ ctx, input }) => run(() => esign.jobStatuses(callerOf(ctx), input.jobIds))),
    cancel: user.input(z.object({ jobIds: z.array(z.uuid()).min(1).max(10) })).mutation(({ ctx, input }) =>
      run(async () => {
        for (const jobId of input.jobIds) await esign.cancelJob(callerOf(ctx), jobId)
      })
    ),
  }),
})
