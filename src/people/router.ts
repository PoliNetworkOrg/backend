import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import { requireGeneral } from "./model"
import type { PeopleService } from "./service"
import type { Viewer } from "./types"

/** Factory keeps policy and shape tests independent of databases and external services. */
export function createPeopleRouter(people: PeopleService) {
  const user = policy({ user: { scope: SCOPE.admin } }).use(async ({ ctx, next }) => {
    if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
    const viewer: Viewer = { sub: ctx.actor.sub, telegramId: ctx.actor.telegramId, can: ctx.can }
    return next({ ctx: { viewer } })
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
    linking: createTRPCRouter({
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
      acceptInvite: self
        .input(z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }))
        .mutation(({ ctx, input }) => people.acceptInvite(ctx.viewer, input)),
    }),
  })
}
