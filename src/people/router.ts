import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { EsignError } from "@/esign/errors"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import { MAX_FILE_BYTES } from "./imports"
import { requireGeneral } from "./model"
import type { PeopleService } from "./service"
import type { Viewer } from "./types"

/** Factory keeps policy and shape tests independent of databases and external services. */
export function createPeopleRouter(people: PeopleService) {
  const user = policy({ user: { scope: SCOPE.admin } }).use(async ({ ctx, next }) => {
    if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
    const viewer: Viewer = { sub: ctx.actor.sub, telegramId: ctx.actor.telegramId, can: ctx.can }
    const result = await next({ ctx: { viewer } })
    if (!result.ok && result.error.cause instanceof EsignError) {
      const err = result.error.cause
      throw new TRPCError({
        code:
          err.code === "forbidden" || err.code === "signer_mismatch"
            ? "FORBIDDEN"
            : err.code === "not_found"
              ? "NOT_FOUND"
              : err.code === "conflict" || err.code === "document_changed"
                ? "CONFLICT"
                : "BAD_REQUEST",
        message: err.message,
        cause: err,
      })
    }
    return result
  })
  const admin = (permission: string) =>
    user.use(({ ctx, next }) => {
      requireGeneral(ctx.viewer, permission)
      return next()
    })
  const self = user.use(({ ctx, next }) => {
    if (!ctx.viewer.can("people:self")) throw new TRPCError({ code: "FORBIDDEN" })
    return next()
  })
  const read = admin("people:read")
  const write = admin("people:write")
  const members = admin("people:members:write")
  const fees = admin("people:fees:write")
  const sign = admin("people:receipts:sign")
  const file = z
    .instanceof(File)
    .refine(
      (f) => f.size > 0 && f.size <= MAX_FILE_BYTES && f.name.length <= 200,
      "File must be 1 byte–10 MB and have a name of at most 200 characters"
    )
  const transfer = z
    .instanceof(FormData)
    .transform((fd) => ({
      file: fd.get("file"),
      transferDate: fd.get("transferDate"),
      amountCents: Number(fd.get("amountCents")),
    }))
    .pipe(C.transferInputSchema.extend({ file }))
  return createTRPCRouter({
    persons: createTRPCRouter({
      list: read.output(C.personRowSchema.array()).query(({ ctx }) => people.listPeople(ctx.viewer)),
      get: read
        .input(z.object({ id: C.personIdSchema }))
        .output(C.personRecordSchema)
        .query(({ ctx, input }) => people.getPerson(ctx.viewer, input)),
      create: write
        .input(C.createPersonInputSchema)
        .output(C.createdSchema)
        .mutation(({ ctx, input }) => people.createPerson(ctx.viewer, input)),
      update: write
        .input(C.updatePersonInputSchema)
        .mutation(({ ctx, input }) => people.updatePerson(ctx.viewer, input)),
      setNote: write.input(C.setNoteInputSchema).mutation(({ ctx, input }) => people.setNote(ctx.viewer, input)),
    }),
    members: createTRPCRouter({
      list: admin("people:members:read")
        .output(C.memberRegisterRowSchema.array())
        .query(({ ctx }) => people.listMembers(ctx.viewer)),
      create: members
        .input(C.createMemberInputSchema)
        .mutation(({ ctx, input }) => people.createMember(ctx.viewer, input)),
      setStatus: members
        .input(C.memberStatusInputSchema)
        .mutation(({ ctx, input }) => people.setMemberStatus(ctx.viewer, input)),
      setNumber: members
        .input(C.memberNumberInputSchema)
        .mutation(({ ctx, input }) => people.setMemberNumber(ctx.viewer, input)),
      export: members.output(C.exportResultSchema).mutation(({ ctx }) => people.exportMembers(ctx.viewer)),
    }),
    admins: createTRPCRouter({
      end: write.input(C.endAdminInputSchema).mutation(({ ctx, input }) => people.endAdmin(ctx.viewer, input)),
      setCapoScope: admin("people:appoint")
        .input(C.capoScopeInputSchema)
        .mutation(({ ctx, input }) => people.setCapoScope(ctx.viewer, input)),
      setCapoOfReference: write
        .input(C.capoRefInputSchema)
        .mutation(({ ctx, input }) => people.setCapoOfReference(ctx.viewer, input)),
    }),
    teams: createTRPCRouter({
      list: user.output(C.teamSummarySchema.array()).query(({ ctx }) => people.listTeams(ctx.viewer)),
      candidates: user
        .input(C.teamCandidatesInputSchema)
        .output(C.teamCandidateSchema.array())
        .query(({ ctx, input }) => people.listTeamCandidates(ctx.viewer, input)),
      addMember: user
        .input(C.addTeamMemberInputSchema)
        .mutation(({ ctx, input }) => people.addTeamMember(ctx.viewer, input)),
      updateFields: user
        .input(C.teamFieldsInputSchema)
        .mutation(({ ctx, input }) => people.updateTeamFields(ctx.viewer, input)),
      endMembership: user
        .input(C.endTeamInputSchema)
        .mutation(({ ctx, input }) => people.endTeamMembership(ctx.viewer, input)),
    }),
    census: createTRPCRouter({
      campaigns: read.output(C.campaignSchema.array()).query(({ ctx }) => people.listCampaigns(ctx.viewer)),
      campaign: read
        .input(z.object({ id: z.string().min(1).max(128) }))
        .output(C.campaignDetailSchema)
        .query(({ ctx, input }) => people.getCampaign(ctx.viewer, input)),
      answers: read
        .input(C.answersInputSchema)
        .output(C.censusAnswersSchema)
        .query(({ ctx, input }) => people.getAnswers(ctx.viewer, input)),
      remind: write
        .input(C.remindInputSchema)
        .output(C.remindResultSchema)
        .mutation(({ ctx, input }) => people.remind(ctx.viewer, input)),
      close: write.input(C.campaignInputSchema).mutation(({ ctx, input }) => people.closeCampaign(ctx.viewer, input)),
      importPreview: write
        .input(
          z
            .instanceof(FormData)
            .transform((fd) => ({ campaignId: fd.get("campaignId"), file: fd.get("file") }))
            .pipe(C.campaignInputSchema.extend({ file }))
        )
        .output(C.importPreviewSchema)
        .mutation(({ ctx, input }) => people.importPreview(ctx.viewer, input)),
      importCommit: write
        .input(C.importCommitInputSchema)
        .output(C.importedSchema)
        .mutation(({ ctx, input }) => people.importCommit(ctx.viewer, input)),
    }),
    linking: createTRPCRouter({
      reviews: read.output(C.reviewSchema.array()).query(({ ctx }) => people.listReviews(ctx.viewer)),
      resolve: write
        .input(C.resolveReviewInputSchema)
        .mutation(({ ctx, input }) => people.resolveReview(ctx.viewer, input)),
      dismiss: write.input(C.reviewInputSchema).mutation(({ ctx, input }) => people.dismissReview(ctx.viewer, input)),
      invites: read.output(C.inviteSchema.array()).query(({ ctx }) => people.listInvites(ctx.viewer)),
      sendInvite: write
        .input(C.personRefInputSchema)
        .mutation(({ ctx, input }) => people.sendInvite(ctx.viewer, input)),
      revokeInvite: write
        .input(C.personRefInputSchema)
        .mutation(({ ctx, input }) => people.revokeInvite(ctx.viewer, input)),
      searchAccounts: write
        .input(C.searchAccountsInputSchema)
        .output(C.accountMatchSchema.array())
        .query(({ ctx, input }) => people.searchAccounts(ctx.viewer, input)),
      link: write.input(C.linkAccountInputSchema).mutation(({ ctx, input }) => people.linkAccount(ctx.viewer, input)),
      unlink: write.input(C.personRefInputSchema).mutation(({ ctx, input }) => people.unlinkAccount(ctx.viewer, input)),
    }),
    capo: createTRPCRouter({
      get: self.output(C.capoAreaSchema).query(({ ctx }) => people.getCapoArea(ctx.viewer)),
    }),
    me: createTRPCRouter({
      roles: self.output(C.myRolesSchema).query(({ ctx }) => people.getMyRoles(ctx.viewer)),
      get: self.output(C.myAreaSchema).query(({ ctx }) => people.getMyArea(ctx.viewer)),
      confirmMatch: self.mutation(({ ctx }) => people.confirmMatch(ctx.viewer)),
      rejectMatch: self.mutation(({ ctx }) => people.rejectMatch(ctx.viewer)),
      acceptInvite: self
        .input(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }))
        .mutation(({ ctx, input }) => people.acceptInvite(ctx.viewer, input)),
      askToBeAdded: self
        .input(C.askToBeAddedInputSchema)
        .mutation(({ ctx, input }) => people.askToBeAdded(ctx.viewer, input)),
      answerCensus: self
        .input(C.answerCensusInputSchema)
        .mutation(({ ctx, input }) => people.answerCensus(ctx.viewer, input)),
      requestCorrection: self
        .input(C.correctionInputSchema)
        .mutation(({ ctx, input }) => people.requestCorrection(ctx.viewer, input)),
      revokePhotoConsent: self.mutation(({ ctx }) => people.revokePhotoConsent(ctx.viewer)),
      uploadTransferReceipt: self
        .input(transfer)
        .mutation(({ ctx, input }) => people.uploadTransferReceipt(ctx.viewer, input)),
      receipt: self
        .input(C.receiptInputSchema)
        .output(C.fileSchema)
        .query(({ ctx, input }) => people.downloadMyReceipt(ctx.viewer, input)),
    }),
    fees: createTRPCRouter({
      review: fees
        .input(C.feePersonInputSchema)
        .output(C.feeReviewSchema)
        .query(({ ctx, input }) => people.getFeeReview(ctx.viewer, input)),
      upload: fees
        .input(C.feePersonInputSchema)
        .output(C.fileSchema)
        .query(({ ctx, input }) => people.getFeeUpload(ctx.viewer, input)),
      approve: fees
        .input(C.feePersonInputSchema)
        .output(C.issuedSchema)
        .mutation(({ ctx, input }) => people.approveFee(ctx.viewer, input)),
      reject: fees.input(C.rejectFeeInputSchema).mutation(({ ctx, input }) => people.rejectFee(ctx.viewer, input)),
      markPaid: fees
        .input(C.markPaidInputSchema)
        .output(C.issuedSchema)
        .mutation(({ ctx, input }) => people.markFeePaid(ctx.viewer, input)),
      remind: fees
        .input(C.feeRemindInputSchema)
        .output(C.remindResultSchema)
        .mutation(({ ctx, input }) => people.remindFees(ctx.viewer, input)),
    }),
    receipts: createTRPCRouter({
      list: admin("people:members:read")
        .input(C.receiptsInputSchema)
        .output(C.receiptsPageSchema)
        .query(({ ctx, input }) => people.listReceipts(ctx.viewer, input)),
      download: admin("people:members:read")
        .input(C.receiptInputSchema)
        .output(C.fileSchema)
        .query(({ ctx, input }) => people.downloadReceipt(ctx.viewer, input)),
      prepareSignatures: sign
        .input(C.prepareReceiptSignaturesInputSchema)
        .output(C.receiptSignaturesSchema)
        .mutation(({ ctx, input }) => people.prepareReceiptSignatures(ctx.viewer, input)),
      toSign: sign.output(C.fileSchema).mutation(({ ctx }) => people.downloadReceiptsToSign(ctx.viewer)),
      previewSigned: sign
        .input(
          z
            .instanceof(FormData)
            .transform((fd) => ({ files: fd.getAll("files") }))
            .pipe(z.object({ files: z.array(file).min(1).max(C.MAX_SIGNED_FILES) }))
        )
        .output(C.signedUploadSchema)
        .mutation(({ ctx, input }) => people.previewSignedReceipts(ctx.viewer, input)),
      sendSigned: sign
        .input(C.sendSignedInputSchema)
        .output(C.sendResultSchema)
        .mutation(({ ctx, input }) => people.sendSignedReceipts(ctx.viewer, input)),
      retry: fees.input(C.receiptInputSchema).mutation(({ ctx, input }) => people.retryReceipt(ctx.viewer, input)),
      void: fees.input(C.voidReceiptInputSchema).mutation(({ ctx, input }) => people.voidReceipt(ctx.viewer, input)),
    }),
  })
}
