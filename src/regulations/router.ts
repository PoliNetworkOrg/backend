import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import type { DiffService } from "./diff/service"
import type { Directory } from "./directory"
import type { EmanationService } from "./emanation/service"
import { fail, type RegulationsService, type Viewer } from "./service"

/**
 * `regulations.*`: every procedure is open to dashboard users (scope `backend:admin`), and the service checks the
 * rest: `regulations:read|write|manage|rectify` from the IdP, per-draft assignments, and deleghe. People with only
 * an assignment use the dashboard too, so nothing here needs a permission at the policy level.
 */
export function createRegulationsRouter(
  service: RegulationsService,
  directory: Directory,
  extras: { diff?: DiffService | null; emanation?: EmanationService | null } = {}
) {
  const diff = () => extras.diff ?? fail("PRECONDITION_FAILED", "Le differenze non sono configurate.")
  const emanation = () => extras.emanation ?? fail("PRECONDITION_FAILED", "L'emanazione non è configurata.")
  const user = policy({ user: { scope: SCOPE.admin } }).use(async ({ ctx, next }) => {
    if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
    const viewer: Viewer = { sub: ctx.actor.sub, can: ctx.can, person: await directory.person(ctx.actor.sub) }
    return next({ ctx: { viewer } })
  })
  const draftRef = C.draftRefInputSchema
  const ok = z.void()

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
      sync: user
        .output(z.object({ documents: z.array(z.string()), imported: z.array(z.string()) }))
        .mutation(({ ctx }) => service.syncDocuments(ctx.viewer)),
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
