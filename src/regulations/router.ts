import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { type AuditTargetOf, audit } from "@/audit/option"
import { dashboard, SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import type { DiffService } from "./diff/service"
import type { Directory } from "./directory"
import type { EmanationService } from "./emanation/service"
import { fail, type RegulationsService, type Viewer } from "./service"

/** The input fields kept in audit events: references to records, states, roles and titles. */
const AUDITED_FIELDS = [
  "draftId",
  "targetDraftId",
  "snapshotId",
  "commentId",
  "delegaId",
  "documentKey",
  "userId",
  "role",
  "to",
  "from.kind",
  "from.id",
  "source.kind",
  "source.id",
  "kind",
  "title",
  "name",
  "expiresAt",
  "template",
  "storage",
] as const

/**
 * The document `documents.create` and `documents.upload` add. They name it `key`, which audit copies hide as a secret,
 * so the event names it as its target. The raw input is JSON for `create` and `FormData` for `upload`.
 */
const newDocument: AuditTargetOf = ({ input }) => {
  const fields = input instanceof FormData ? Object.fromEntries(input.entries()) : input
  if (fields === null || typeof fields !== "object") return null
  const { key, title } = fields as Record<string, unknown>
  if (typeof key !== "string") return null
  return { type: "regulations.document", id: key, label: typeof title === "string" ? title : null }
}

/**
 * `regulations.*`: every procedure is open to dashboard users (scope `backend:admin`), and the service checks the
 * rest: `regulations:read|write|manage|rectify` from the IdP, per-draft assignments, and deleghe. People with only
 * an assignment use the dashboard too, so most procedures need no permission at the policy level; creating and
 * uploading documents is only for `regulations:manage`, which the policy carries as well.
 */
export function createRegulationsRouter(
  service: RegulationsService,
  directory: Directory,
  extras: { diff?: DiffService | null; emanation?: EmanationService | null } = {}
) {
  const diff = () => extras.diff ?? fail("PRECONDITION_FAILED", "Le differenze non sono configurate.")
  const emanation = () => extras.emanation ?? fail("PRECONDITION_FAILED", "L'emanazione non è configurata.")
  // Comments, snapshots, deleghe and delibere keep their own authors and text: the audit log keeps only which records a
  // call names, never comment bodies, quotes, merge resolutions, delibere or notes.
  const user = policy({ user: { scope: SCOPE.admin } })
    .meta(audit.full({ fields: AUDITED_FIELDS }))
    .use(async ({ ctx, next }) => {
      if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
      const viewer: Viewer = { sub: ctx.actor.sub, can: ctx.can, person: await directory.person(ctx.actor.sub) }
      return next({ ctx: { viewer } })
    })
  const manager = policy(dashboard(C.REGULATION_PERMISSIONS.manage))
    .meta(audit.full({ fields: AUDITED_FIELDS }))
    .use(async ({ ctx, next }) => {
      if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
      const viewer: Viewer = { sub: ctx.actor.sub, can: ctx.can, person: await directory.person(ctx.actor.sub) }
      return next({ ctx: { viewer } })
    })
  const draftRef = C.draftRefInputSchema
  const ok = z.void()
  const pdf = z.instanceof(File).refine((f) => f.size <= C.MAX_UPLOAD_BYTES, "Il PDF supera i 20 MB.")
  const uploadDocument = z
    .instanceof(FormData)
    .transform((fd) => ({ key: fd.get("key"), title: fd.get("title"), file: fd.get("file") }))
    .pipe(C.uploadDocumentFieldsSchema.extend({ file: pdf }))
  const uploadVersion = z
    .instanceof(FormData)
    .transform((fd) => ({ documentKey: fd.get("documentKey"), file: fd.get("file") }))
    .pipe(C.uploadVersionFieldsSchema.extend({ file: pdf }))

  return createTRPCRouter({
    me: createTRPCRouter({
      get: user.output(C.meSchema).query(({ ctx }) => service.me(ctx.viewer)),
    }),
    users: createTRPCRouter({
      search: user
        .input(C.userSearchInputSchema)
        .output(C.userMatchSchema.array())
        .query(({ ctx, input }) => service.searchUsers(ctx.viewer, input.q)),
    }),
    documents: createTRPCRouter({
      list: user.output(C.documentSchema.array()).query(({ ctx }) => service.listDocuments(ctx.viewer)),
      get: user
        .input(z.object({ documentKey: C.documentKeySchema }))
        .output(C.documentSchema)
        .query(({ ctx, input }) => service.getDocument(ctx.viewer, input.documentKey)),
      sync: user.output(C.syncResultSchema).mutation(async ({ ctx }) => {
        const result = await service.syncDocuments(ctx.viewer)
        // Sync takes no input: what it imported, updated and skipped is the only trace of what it changed.
        ctx.audit.set({ after: { imported: result.imported, updated: result.updated, skipped: result.skipped } })
        return result
      }),
      create: manager
        .meta(audit.full({ fields: AUDITED_FIELDS, target: newDocument }))
        .input(C.createDocumentInputSchema)
        .output(C.documentSchema)
        .mutation(({ ctx, input }) =>
          input.storage === "private"
            ? service.createPrivateDocument(ctx.viewer, input)
            : emanation().createDocument(ctx.viewer, input)
        ),
      upload: manager
        .meta(audit.full({ fields: AUDITED_FIELDS, target: newDocument }))
        .input(uploadDocument)
        .output(C.documentSchema)
        .mutation(({ ctx, input }) => service.uploadDocument(ctx.viewer, input)),
    }),
    templates: createTRPCRouter({
      list: user.output(C.templateSchema.array()).query(({ ctx }) => service.listTemplates(ctx.viewer)),
    }),
    versions: createTRPCRouter({
      list: user
        .input(z.object({ documentKey: C.documentKeySchema }))
        .output(C.versionSummarySchema.array())
        .query(({ ctx, input }) => service.listVersions(ctx.viewer, input.documentKey)),
      pdf: user
        .input(z.object({ versionId: z.string().min(1) }))
        .output(C.binaryFileSchema)
        .query(({ ctx, input }) => service.versionPdf(ctx.viewer, input.versionId)),
      upload: manager
        .input(uploadVersion)
        .output(C.versionSummarySchema)
        .mutation(({ ctx, input }) => service.uploadVersion(ctx.viewer, input)),
    }),
    drafts: createTRPCRouter({
      list: user
        .input(C.listDraftsInputSchema)
        .output(C.draftSummarySchema.array())
        .query(({ ctx, input }) => service.listDrafts(ctx.viewer, input)),
      get: user
        .input(draftRef)
        .output(C.draftSchema)
        .query(({ ctx, input }) => service.getDraft(ctx.viewer, input.draftId)),
      create: user
        .input(C.createDraftInputSchema)
        .output(C.draftSchema)
        .mutation(({ ctx, input }) => service.createDraft(ctx.viewer, input)),
      reveal: user
        .input(draftRef)
        .output(C.draftSchema)
        .mutation(({ ctx, input }) => service.revealDraft(ctx.viewer, input.draftId)),
      rename: user
        .input(C.renameDraftInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.renameDraft(ctx.viewer, input)),
      delete: user
        .input(draftRef)
        .output(ok)
        .mutation(({ ctx, input }) => service.deleteDraft(ctx.viewer, input.draftId)),
      files: user
        .input(draftRef)
        .output(C.draftFilesSchema)
        .query(({ ctx, input }) => service.draftFiles(ctx.viewer, input.draftId)),
      transition: user
        .input(C.transitionInputSchema)
        .output(C.draftSchema)
        .mutation(({ ctx, input }) => service.transition(ctx.viewer, input)),
    }),
    assignments: createTRPCRouter({
      list: user
        .input(draftRef)
        .output(C.assignmentSchema.array())
        .query(({ ctx, input }) => service.listAssignments(ctx.viewer, input.draftId)),
      set: user
        .input(C.setAssignmentInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.setAssignment(ctx.viewer, input)),
      remove: user
        .input(C.removeAssignmentInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.removeAssignment(ctx.viewer, input)),
    }),
    collabTicket: user
      .meta(audit.none("Hands out a one-minute ticket to connect to the editor; it changes nothing"))
      .input(draftRef)
      .output(C.collabTicketSchema)
      .mutation(({ ctx, input }) => service.collabTicket(ctx.viewer, input.draftId)),
    compile: createTRPCRouter({
      status: user
        .input(draftRef)
        .output(C.compileStatusSchema)
        .query(({ ctx, input }) => service.compileStatus(ctx.viewer, input.draftId)),
      pdf: user
        .input(C.compilePdfInputSchema)
        .output(C.binaryFileSchema)
        .query(({ ctx, input }) => service.compilePdf(ctx.viewer, input)),
    }),
    snapshots: createTRPCRouter({
      list: user
        .input(draftRef)
        .output(C.snapshotSchema.array())
        .query(({ ctx, input }) => service.listSnapshots(ctx.viewer, input.draftId)),
      get: user
        .input(C.snapshotRefInputSchema)
        .output(C.snapshotWithFilesSchema)
        .query(({ ctx, input }) => service.getSnapshot(ctx.viewer, input.snapshotId)),
      create: user
        .input(C.createSnapshotInputSchema)
        .output(C.snapshotSchema)
        .mutation(({ ctx, input }) => service.createSnapshot(ctx.viewer, input)),
      restore: user
        .input(C.snapshotRefInputSchema)
        .output(C.snapshotSchema)
        .mutation(({ ctx, input }) => service.restoreSnapshot(ctx.viewer, input.snapshotId)),
    }),
    comments: createTRPCRouter({
      list: user
        .input(draftRef)
        .output(C.commentThreadSchema.array())
        .query(({ ctx, input }) => service.listComments(ctx.viewer, input.draftId)),
      create: user
        .input(C.createCommentInputSchema)
        .output(z.object({ id: z.string() }))
        .mutation(({ ctx, input }) => service.createComment(ctx.viewer, input)),
      reply: user
        .input(C.replyCommentInputSchema)
        .output(z.object({ id: z.string() }))
        .mutation(({ ctx, input }) => service.replyComment(ctx.viewer, input)),
      resolve: user
        .input(C.commentRefInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.resolveComment(ctx.viewer, input.commentId)),
      reopen: user
        .input(C.commentRefInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.reopenComment(ctx.viewer, input.commentId)),
      delete: user
        .input(C.commentRefInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.deleteComment(ctx.viewer, input.commentId)),
    }),
    merge: createTRPCRouter({
      preview: user
        .input(C.mergeInputSchema)
        .output(C.mergePreviewSchema)
        .query(({ ctx, input }) => service.previewMerge(ctx.viewer, input)),
      execute: user
        .input(C.applyMergeInputSchema)
        .output(z.object({ snapshotId: z.string() }))
        .mutation(({ ctx, input }) => service.applyMerge(ctx.viewer, input)),
    }),
    diff: createTRPCRouter({
      get: user
        .input(draftRef)
        .output(C.diffSchema)
        .query(({ ctx, input }) => diff().get(ctx.viewer, input.draftId)),
      regenerate: user
        .input(draftRef)
        .output(C.diffSchema)
        .mutation(({ ctx, input }) => diff().regenerate(ctx.viewer, input.draftId)),
      pdf: user
        .input(draftRef)
        .output(C.binaryFileSchema)
        .query(({ ctx, input }) => diff().pdf(ctx.viewer, input.draftId)),
    }),
    emanation: createTRPCRouter({
      get: user
        .input(draftRef)
        .output(C.emanationSchema)
        .query(({ ctx, input }) => emanation().get(ctx.viewer, input.draftId)),
      start: user
        .input(draftRef)
        .output(C.emanationSchema)
        .mutation(({ ctx, input }) => emanation().start(ctx.viewer, input.draftId)),
      retry: user
        .input(draftRef)
        .output(C.emanationSchema)
        .mutation(({ ctx, input }) => emanation().retry(ctx.viewer, input.draftId)),
    }),
    deleghe: createTRPCRouter({
      list: user.output(C.delegaSchema.array()).query(({ ctx }) => service.listDeleghe(ctx.viewer)),
      create: user
        .input(C.createDelegaInputSchema)
        .output(C.delegaSchema)
        .mutation(({ ctx, input }) => service.createDelega(ctx.viewer, input)),
      revoke: user
        .input(C.delegaRefInputSchema)
        .output(ok)
        .mutation(({ ctx, input }) => service.revokeDelega(ctx.viewer, input.delegaId)),
    }),
  })
}
