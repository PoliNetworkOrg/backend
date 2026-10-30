import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import { requireGeneral } from "./model"
import type { PeopleService } from "./service"
import type { Viewer } from "./types"

/**
 * Factory keeps policy and shape tests independent of databases and external services.
 *
 * The service checks every role change again with the same rules as PoliNetwork Auth (`rules.ts`). Team changes
 * are open to every dashboard user here, since a team's Lead may add and remove its members.
 */
export function createPeopleRouter(people: PeopleService) {
  const user = policy({ user: { scope: SCOPE.admin } }).use(async ({ ctx, next }) => {
    if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
    const sub = ctx.actor.sub
    const viewer: Viewer = {
      sub,
      telegramId: ctx.actor.telegramId,
      can: ctx.can,
      holdsRole: (role) => {
        const index = ctx.access?.current()
        return !!index && index.hasRole(index.bySub(sub), role)
      },
    }
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
  const appoint = admin("people:appoint")
  /** Linking hands an account the record's roles, so it has its own permission. */
  const link = admin("people:link")
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
      list: read.output(C.adminSummarySchema.array()).query(({ ctx }) => people.listAdmins(ctx.viewer)),
      assign: write.input(C.assignAdminInputSchema).mutation(({ ctx, input }) => people.assignAdmin(ctx.viewer, input)),
      end: write.input(C.endAssignmentInputSchema).mutation(({ ctx, input }) => people.endAdmin(ctx.viewer, input)),
      setCapoOfReference: write
        .input(C.capoRefInputSchema)
        .mutation(({ ctx, input }) => people.setCapoOfReference(ctx.viewer, input)),
    }),
    capos: createTRPCRouter({
      list: read.output(C.capoSummarySchema.array()).query(({ ctx }) => people.listCapos(ctx.viewer)),
      appoint: appoint
        .input(C.appointCapoInputSchema)
        .mutation(({ ctx, input }) => people.appointCapo(ctx.viewer, input)),
      setScope: appoint
        .input(C.capoScopeInputSchema)
        .mutation(({ ctx, input }) => people.setCapoScope(ctx.viewer, input)),
      end: appoint.input(C.endAssignmentInputSchema).mutation(({ ctx, input }) => people.endCapo(ctx.viewer, input)),
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
      recent: read.output(C.recentLinkSchema.array()).query(({ ctx }) => people.listRecentLinks(ctx.viewer)),
      // People writers, or the Lead of one of the person's teams: the service decides.
      sendInvite: user.input(C.personRefInputSchema).mutation(({ ctx, input }) => people.sendInvite(ctx.viewer, input)),
      revokeInvite: user
        .input(C.personRefInputSchema)
        .mutation(({ ctx, input }) => people.revokeInvite(ctx.viewer, input)),
      searchAccounts: link
        .input(C.searchAccountsInputSchema)
        .output(C.accountMatchSchema.array())
        .query(({ ctx, input }) => people.searchAccounts(ctx.viewer, input)),
      link: link.input(C.linkAccountInputSchema).mutation(({ ctx, input }) => people.linkAccount(ctx.viewer, input)),
      unlink: link
        .input(C.unlinkAccountInputSchema)
        .mutation(({ ctx, input }) => people.unlinkAccount(ctx.viewer, input)),
    }),
    capo: createTRPCRouter({
      get: self.output(C.capoAreaSchema).query(({ ctx }) => people.getCapoArea(ctx.viewer)),
    }),
    me: createTRPCRouter({
      roles: self.output(C.myRolesSchema).query(({ ctx }) => people.getMyRoles(ctx.viewer)),
      get: self.output(C.myAreaSchema).query(({ ctx }) => people.getMyArea(ctx.viewer)),
      // Any signed-in account with a valid token: someone new holds no People permission yet.
      invite: user
        .input(C.inviteTokenInputSchema)
        .output(C.invitePreviewSchema)
        .query(({ ctx, input }) => people.previewInvite(ctx.viewer, input)),
      acceptInvite: user
        .input(C.inviteTokenInputSchema)
        .mutation(({ ctx, input }) => people.acceptInvite(ctx.viewer, input)),
    }),
  })
}
