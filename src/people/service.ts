import { randomBytes } from "node:crypto"
import * as C from "./contract"
import {
  fail,
  find,
  general,
  hash,
  leads,
  log,
  nameOf,
  newPerson,
  own,
  queue,
  record,
  ref,
  requireGeneral,
  requireOwn,
  requireSelf,
  row,
  teamAccess,
  today,
  validateFields,
} from "./model"
import type { Account, PeopleState, PeopleStore, Person, UnitOfWork, Viewer } from "./types"

export type PeopleOptions = {
  store: PeopleStore
  /** Dashboard origin, for links in emails. */
  dashboardUrl: string
  now?: () => Date
  directory: () => Promise<Account[]>
  sendMail: (mail: { id: string; to: string; subject: string; text: string }) => Promise<void>
}

export function createPeopleService(options: PeopleOptions) {
  const { store, dashboardUrl } = options
  const now = options.now ?? (() => new Date())
  const date = () => today(now())
  const tx = <T>(fn: (u: UnitOfWork) => Promise<T> | T) => store.transaction(async (u) => fn(u))
  function link(s: PeopleState, p: Person, account: Account, actor: string, reason: string) {
    if (Object.values(s.persons).some((other) => other.id !== p.id && other.accountSub === account.sub))
      fail("CONFLICT", "This account is already linked to another person")
    if (p.accountSub && p.accountSub !== account.sub) fail("CONFLICT", "Unlink the existing account first")
    p.accountSub = account.sub
    p.account = { status: "linked", email: account.email ?? "", via: "IdP", linkedOn: date(), how: reason }
    p.invite = null
    log(p, actor, `Linked account ${account.sub}: ${reason}`, now())
  }

  return {
    async listPeople(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) => Object.values(u.state.persons).map((p) => row(u.state, p, v)))
    },
    async getPerson(v: Viewer, input: { id: string }) {
      requireGeneral(v, "people:read")
      return tx((u) => record(u.state, find(u.state, input.id), v))
    },
    async createPerson(v: Viewer, input: C.CreatePersonInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = newPerson(u.state, input, date())
        log(p, v.sub, "Created person", now())
        return { id: p.id }
      })
    },
    async updatePerson(v: Viewer, input: C.UpdatePersonInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.id)
        const { id: _, ...profile } = input
        Object.assign(p.profile, profile)
        log(p, v.sub, "Updated profile", now())
      })
    },
    async setNote(v: Viewer, input: C.SetNoteInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.id)
        p.notes = input.note || null
        log(p, v.sub, "Updated HR note", now())
      })
    },
    async endAdmin(v: Viewer, input: C.EndAdminInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.admin?.status !== "active") fail("CONFLICT", "Not an active admin")
        if (p.admin.capoScope) requireGeneral(v, "people:appoint")
        Object.assign(p.admin, { status: "former", endedOn: date(), endReason: input.reason, capoScope: null })
        log(p, v.sub, `Ended admin role: ${input.reason}`, now())
      })
    },
    async setCapoScope(v: Viewer, input: C.CapoScopeInput) {
      requireGeneral(v, "people:appoint")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.admin?.status !== "active") fail("CONFLICT", "Not an active admin")
        p.admin.capoScope = input.scope || null
        log(p, v.sub, `Set Capo Admin scope: ${input.scope ?? "none"}`, now())
      })
    },
    async setCapoOfReference(v: Viewer, input: C.CapoRefInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.admin?.status !== "active") fail("CONFLICT", "Not an active admin")
        const capo = input.capoId ? find(u.state, input.capoId) : null
        if (capo && (capo.id === p.id || capo.admin?.status !== "active" || !capo.admin.capoScope))
          fail("BAD_REQUEST", "Choose an active Capo Admin")
        p.admin.capoOfReference = capo ? ref(capo) : null
        log(p, v.sub, "Changed Capo Admin of reference", now())
      })
    },
    async listTeams(v: Viewer) {
      return tx((u) => {
        const allowed = general(v, "people:read") ? [...C.TEAM_IDS] : v.can("people:self") ? leads(own(u.state, v)) : []
        if (!allowed.length) fail("FORBIDDEN", "No readable teams")
        return allowed.map((id) => {
          const full = general(v, "people:read")
          const people = Object.values(u.state.persons).filter((p) =>
            p.teams.some((t) => t.team === id && (full || !t.endedOn))
          )
          const lead = people.find((p) => leads(p, id).length)
          return {
            id,
            name: C.TEAMS[id].name,
            lead: lead ? ref(lead) : null,
            members: people.map((p) => {
              const result = row(u.state, p, v, true)
              if (!general(v, "people:read")) result.teams = result.teams.filter((t) => t.team === id)
              return result
            }),
          }
        })
      })
    },
    async listTeamCandidates(v: Viewer, input: C.TeamCandidatesInput) {
      return tx((u) => {
        teamAccess(u.state, v, input.teamId, false)
        return Object.values(u.state.persons)
          .filter((p) => !p.teams.some((m) => m.team === input.teamId && !m.endedOn))
          .map((p) => ({ ...ref(p), course: p.profile.course }))
      })
    },
    async addTeamMember(v: Viewer, input: C.AddTeamMemberInput) {
      return tx((u) => {
        teamAccess(u.state, v, input.teamId, true)
        if (input.role === "lead") requireGeneral(v, "people:appoint")
        validateFields(input.teamId, input.fields)
        const p = find(u.state, input.personId)
        if (p.teams.some((t) => t.team === input.teamId && !t.endedOn)) fail("CONFLICT", "Already active in this team")
        if (input.role === "lead" && Object.values(u.state.persons).some((p) => leads(p, input.teamId).length))
          fail("CONFLICT", "End the existing Lead appointment first")
        if (input.since > date()) fail("BAD_REQUEST", "Start date is in the future")
        p.teams.push({
          team: input.teamId,
          role: input.role,
          since: input.since,
          endedOn: null,
          endReason: null,
          fields: input.fields,
        })
        log(p, v.sub, `Joined ${input.teamId} as ${input.role}`, now())
      })
    },
    async updateTeamFields(v: Viewer, input: C.TeamFieldsInput) {
      return tx((u) => {
        teamAccess(u.state, v, input.teamId, true)
        validateFields(input.teamId, input.fields)
        const p = find(u.state, input.personId)
        const t = p.teams.find((t) => t.team === input.teamId && !t.endedOn)
        if (!t) fail("CONFLICT", "No active team membership")
        t.fields = input.fields
        log(p, v.sub, `Updated ${input.teamId} fields`, now())
      })
    },
    async endTeamMembership(v: Viewer, input: C.EndTeamInput) {
      return tx((u) => {
        teamAccess(u.state, v, input.teamId, true)
        const p = find(u.state, input.personId)
        const t = p.teams.find((t) => t.team === input.teamId && !t.endedOn)
        if (!t) fail("CONFLICT", "No active team membership")
        if (t.role === "lead") requireGeneral(v, "people:appoint")
        if (input.lastDay < t.since || input.lastDay > date()) fail("BAD_REQUEST", "Invalid last day")
        Object.assign(t, { endedOn: input.lastDay, endReason: input.reason })
        log(p, v.sub, `Ended ${input.teamId}: ${input.reason}${input.note ? `; ${input.note}` : ""}`, now())
      })
    },
    async listInvites(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) =>
        Object.values(u.state.persons).flatMap((p) =>
          p.account.status === "invite" ? [{ personId: p.id, name: nameOf(p), ...p.account }] : []
        )
      )
    },
    async sendInvite(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.accountSub || !p.profile.personalEmail)
          fail("CONFLICT", "Account already linked or personal email missing")
        const token = randomBytes(32).toString("base64url")
        p.invite = { hash: hash(token), expiresAt: new Date(now().getTime() + 14 * 86400000).toISOString() }
        p.account = {
          status: "invite",
          email: p.profile.personalEmail,
          sentOn: date(),
          expiresOn: p.invite.expiresAt.slice(0, 10),
          sentBy: v.sub,
        }
        queue(
          u.state,
          p,
          `invite:${p.id}:${p.invite.hash}`,
          p.profile.personalEmail,
          "PoliNetwork · collega il tuo account",
          `${dashboardUrl}/dashboard/account/me?peopleInvite=${token}`
        )
        log(p, v.sub, "Queued account invitation", now())
      })
    },
    async revokeInvite(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.account.status !== "invite") fail("CONFLICT", "No pending invitation")
        p.invite = null
        p.account = { status: "none" }
        log(p, v.sub, "Revoked account invitation", now())
      })
    },
    async searchAccounts(v: Viewer, input: C.SearchAccountsInput) {
      requireGeneral(v, "people:write")
      const accounts = await options.directory()
      return tx((u) => {
        const p = find(u.state, input.personId)
        const q = input.query.toLowerCase()
        return accounts
          .filter((a) => !q || `${a.name} ${a.email ?? ""} ${a.telegramId ?? ""}`.toLowerCase().includes(q))
          .slice(0, 100)
          .map((a) => {
            const linked = Object.values(u.state.persons).find((p) => p.accountSub === a.sub)
            return {
              id: a.sub,
              name: a.name,
              email: a.email ?? "",
              telegram: a.telegramId,
              via: "IdP",
              linkedTo: linked ? ref(linked) : null,
              reason:
                a.telegramId && a.telegramId === p.profile.telegramId
                  ? ("same-telegram" as const)
                  : a.email?.toLowerCase() === p.profile.personalEmail?.toLowerCase()
                    ? ("same-email" as const)
                    : ("similar-name" as const),
            }
          })
      })
    },
    async linkAccount(v: Viewer, input: C.LinkAccountInput) {
      requireGeneral(v, "people:write")
      const account = (await options.directory()).find((a) => a.sub === input.accountId)
      if (!account) fail("NOT_FOUND", "IdP account not found")
      return tx((u) => link(u.state, find(u.state, input.personId), account, v.sub, input.reason))
    },
    async unlinkAccount(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (!p.accountSub) fail("CONFLICT", "Account not linked")
        p.accountSub = null
        p.account = { status: "none" }
        log(p, v.sub, "Unlinked account", now())
      })
    },
    async acceptInvite(v: Viewer, input: { token: string }) {
      requireSelf(v)
      const account = (await options.directory()).find((a) => a.sub === v.sub)
      if (!account?.email) fail("FORBIDDEN", "Verified account email required")
      return tx((u) => {
        const p = Object.values(u.state.persons).find(
          (p) => p.invite?.hash === hash(input.token) && p.invite.expiresAt > now().toISOString()
        )
        if (!p || p.profile.personalEmail?.toLowerCase() !== account.email?.toLowerCase())
          fail("NOT_FOUND", "Invitation expired or not addressed to this account")
        link(u.state, p, account, v.sub, "Accepted email invitation")
      })
    },

    async getMyRoles(v: Viewer) {
      requireSelf(v)
      return tx((u) => {
        const p = own(u.state, v)
        return { capoScope: p?.admin?.status === "active" ? p.admin.capoScope : null, leads: leads(p) }
      })
    },
    async getMyArea(v: Viewer): Promise<C.MyArea> {
      requireSelf(v)
      return tx((u) => {
        const p = own(u.state, v)
        if (!p) return { state: "none" }
        const team = p.teams.find((t) => !t.endedOn)?.team
        const contacts: Extract<C.MyArea, { state: "linked" }>["contacts"] = []
        const capoId = p.admin?.capoOfReference?.id
        const capo = capoId ? u.state.persons[capoId] : null
        if (capo)
          contacts.push({ role: "capo", name: nameOf(capo), telegram: capo.profile.telegramUsername, team: null })
        for (const other of Object.values(u.state.persons)) {
          for (const t of other.teams.filter(
            (t) => !t.endedOn && t.role === "lead" && p.teams.some((mine) => !mine.endedOn && mine.team === t.team)
          ))
            contacts.push({ role: "lead", name: nameOf(other), telegram: other.profile.telegramUsername, team: t.team })
          if (other.teams.some((t) => t.team === "hr" && !t.endedOn))
            contacts.push({ role: "hr", name: nameOf(other), telegram: other.profile.telegramUsername, team: "hr" })
        }
        return {
          state: "linked",
          person: record(u.state, p, v),
          contacts,
          roster: team
            ? {
                team,
                members: Object.values(u.state.persons).flatMap((other) => {
                  const t = other.teams.find((t) => t.team === team && !t.endedOn)
                  return t ? [{ ...ref(other), role: t.role, telegram: other.profile.telegramUsername }] : []
                }),
              }
            : null,
        }
      })
    },
    async getCapoArea(v: Viewer): Promise<C.CapoArea> {
      requireSelf(v)
      return tx((u) => {
        const p = requireOwn(u.state, v)
        const scope = p.admin?.status === "active" ? p.admin.capoScope : null
        if (!scope) fail("FORBIDDEN", "No active Capo Admin scope")
        return {
          scope,
          admins: Object.values(u.state.persons)
            .filter((other) => other.admin?.status === "active" && other.admin.capoOfReference?.id === p.id)
            .map((other) => {
              const r = row(u.state, other, v, true)
              r.profile.personalEmail = null
              return r
            }),
        }
      })
    },

    /** Sends queued mail; the cron calls it every minute. */
    async deliverPending() {
      // Claim and record intent before network I/O. Unknown outcomes require an explicit retry.
      const claimed = await tx((u) => {
        for (const mail of Object.values(u.state.outbox))
          if (
            mail.status === "sending" &&
            mail.attemptedAt &&
            now().getTime() - Date.parse(mail.attemptedAt) > 10 * 60000
          ) {
            mail.status = "failed"
            mail.error = "Delivery outcome unknown after interruption; check the mailbox before retrying"
          }
        const pending = Object.values(u.state.outbox)
          .filter((m) => m.status === "pending")
          .slice(0, 20)
        for (const mail of pending) {
          mail.status = "sending"
          mail.attemptedAt = now().toISOString()
        }
        return pending
      })
      for (const mail of claimed) {
        let error: string | null = null
        try {
          await options.sendMail({ id: mail.id, to: mail.to, subject: mail.subject, text: mail.text })
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
        await tx((u) => {
          const current = u.state.outbox[mail.id]
          if (current.status !== "sending" || current.attemptedAt !== mail.attemptedAt) return
          current.status = error ? "failed" : "sent"
          current.error = error
          const p = u.state.persons[mail.personId]
          log(p, "system", error ? `Email failed: ${error}` : `Sent email: ${mail.subject}`, now())
        })
      }
    },
  }
}
export type PeopleService = ReturnType<typeof createPeopleService>
