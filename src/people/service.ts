import { randomBytes, randomUUID } from "node:crypto"
import * as C from "./contract"
import {
  assignmentsOf,
  clearCapoReferences,
  confirmed,
  confirmedOf,
  current,
  fail,
  find,
  general,
  hash,
  leadsOf,
  log,
  nameOf,
  newAssignment,
  newPerson,
  openInvite,
  own,
  queueMail,
  record,
  ref,
  requireGeneral,
  requireOwn,
  requireSelf,
  row,
  today,
  touch,
  validateFields,
  waiting,
} from "./model"
import {
  bindingsOf,
  type Concept,
  conceptOf,
  isBound,
  type PeopleRoles,
  RoleChangeError,
  type RoleCommand,
  type RoleDirectory,
  type RoleResult,
  rolesFor,
} from "./roles"
import { type BoundRole, peopleRoleChangeProblem } from "./rules"
import { reconcile, syncDirectory } from "./sync"
import type { Account, Assignment, PeopleStore, Person, StoredCommand, UnitOfWork, Viewer } from "./types"

const longDate = (iso: string) =>
  new Intl.DateTimeFormat("it-IT", { timeZone: "Europe/Rome", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(iso)
  )
/** The invite email. Any account will do: the link is the proof, not the address it was sent to. */
function inviteText(p: Person, url: string, expiresAt: string) {
  return [
    `Ciao ${p.firstName},`,
    "",
    "ti abbiamo aggiunto al registro delle persone di PoliNetwork. Per collegarlo al tuo account, apri questo link e accedi:",
    "",
    url,
    "",
    "Usa l'account con cui entrerai nella dashboard: quello PoliNetwork se fai parte dei soci, altrimenti un qualsiasi account Google. Non deve per forza essere questo indirizzo.",
    "",
    `Il link funziona una sola volta e scade il ${longDate(expiresAt)}. Se non sai di cosa si tratta, ignora questa email.`,
  ].join("\n")
}

export type PeopleOptions = {
  store: PeopleStore
  /** Dashboard origin, for links in emails. */
  dashboardUrl: string
  now?: () => Date
  /** IdP login accounts, to link a record by hand. */
  directory: () => Promise<Account[]>
  /** Who holds the roles bound to People, and changes to them; null when Auth isn't configured. */
  peopleRoles: PeopleRoles | null
  sendMail: (mail: { id: string; to: string; subject: string; text: string }) => Promise<void>
}

/** How long People reuses Auth's answer about who holds which role. It stores no copy of it. */
export const DIRECTORY_TTL_MS = 15_000
/** Past this without an answer, People refuses to work rather than decide who holds a role from an old one. */
export const DIRECTORY_MAX_AGE_MS = 60 * 60_000
const WAITING = "A role change for this person is waiting for PoliNetwork Auth; try again in a moment."

const refusalCode = (status: number) =>
  status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "PRECONDITION_FAILED"

export function createPeopleService(options: PeopleOptions) {
  const { store, dashboardUrl, peopleRoles } = options
  const now = options.now ?? (() => new Date())
  const date = () => today(now())
  const clock = () => ({ date: date(), now: now() })

  type Read = { value: RoleDirectory; at: number; revision: number }
  /** The last good answer. Kept while stale, as the fallback during an outage. */
  let directoryRead: Read | null = null
  let stale = false
  /** Auth's answer, from cache for {@link DIRECTORY_TTL_MS}, or the last one during a short outage. */
  async function readDirectory(): Promise<Read | null> {
    if (!peopleRoles) return null
    const at = now().getTime()
    if (!stale && directoryRead && at - directoryRead.at < DIRECTORY_TTL_MS) return directoryRead
    // A role change Auth confirms while it answers makes this answer older than the register.
    const revision = await store.transaction(async (u) => u.state.counters.roleRevision ?? 0)
    try {
      const value = await peopleRoles.directory()
      // Answers can arrive out of order: one from a read that started earlier never replaces a later one.
      if (directoryRead && at < directoryRead.at) return directoryRead
      directoryRead = { value, at, revision }
      stale = false
    } catch (error) {
      if (!directoryRead || at - directoryRead.at > DIRECTORY_MAX_AGE_MS)
        fail("PRECONDITION_FAILED", "PoliNetwork Auth can't be reached: People can't tell who holds which role")
      console.error(error)
    }
    return directoryRead
  }
  const bumpRevision = (u: UnitOfWork) => {
    u.state.counters.roleRevision = (u.state.counters.roleRevision ?? 0) + 1
  }

  type Ctx = {
    /** Auth's answer; null without Auth. */
    directory: RoleDirectory | null
    /** Sends the command once the transaction commits; `strict` fails the call when Auth refuses it. */
    send: (personId: string, command: RoleCommand, strict: boolean, purpose?: StoredCommand["purpose"]) => void
  }
  /** A People transaction that first lays Auth's answer over the register, then delivers the role commands it queued. */
  async function tx<T>(fn: (u: UnitOfWork, ctx: Ctx) => Promise<T> | T): Promise<T> {
    const read = await readDirectory()
    const deliveries: { id: string; strict: boolean }[] = []
    const result = await store.transaction(async (u) => {
      if (read) {
        // An older answer than the register's last confirmation, or than the last answer applied (by this or
        // another instance), would undo it: read again next time.
        const { roleRevision = 0, directoryReadAt = 0 } = u.state.counters
        if (read.revision !== roleRevision || read.at < directoryReadAt) stale = true
        else {
          syncDirectory(u, read.value, clock())
          u.state.counters.directoryReadAt = read.at
        }
      }
      return fn(u, {
        directory: read?.value ?? null,
        send(personId, command, strict, purpose = "roles") {
          u.state.commands[command.id] = {
            id: command.id,
            personId,
            request: command,
            purpose,
            status: "queued",
            attempts: 0,
            error: null,
            createdAt: now().toISOString(),
            answeredAt: null,
          }
          deliveries.push({ id: command.id, strict })
        },
      })
    })
    for (const delivery of deliveries) {
      const refused = await deliver(delivery.id)
      if (refused && delivery.strict) fail(refusalCode(refused.status), `PoliNetwork Auth: ${refused.message}`)
    }
    return result
  }

  /**
   * Sends a queued role command and applies Auth's answer; returns Auth's refusal. Without an answer the command
   * stays queued, and the sweep sends it again with the same ID, which Auth applies at most once.
   */
  async function deliver(id: string): Promise<RoleChangeError | null> {
    const [pending, revision] = await store.transaction(async (u) => [
      structuredClone(u.state.commands[id]),
      u.state.counters.roleRevision ?? 0,
    ])
    if (!pending || pending.status !== "queued" || !peopleRoles) return null
    let result: RoleResult
    try {
      result = await peopleRoles.change(pending.request)
    } catch (error) {
      if (!(error instanceof RoleChangeError)) console.error(error)
      const failure = error instanceof RoleChangeError ? error : new RoleChangeError(503, "No answer")
      await store.transaction(async (u) => {
        const command = u.state.commands[id]
        if (command?.status !== "queued") return
        command.attempts += 1
        command.error = failure.message
        if (failure.unanswered) {
          if (command.attempts === 1)
            log(
              u,
              command.personId,
              "system",
              `PoliNetwork Auth didn't answer (${failure.message}); the change will be sent again`,
              now()
            )
          return
        }
        command.status = "refused"
        command.answeredAt = now().toISOString()
        if (command.purpose === "unlink") {
          // The account stays linked, with the roles Auth still holds.
          for (const a of Object.values(u.state.assignments).filter((a) => a.commandId === id))
            Object.assign(a, { status: "applied", commandId: null })
          log(
            u,
            command.personId,
            command.request.actor,
            `PoliNetwork Auth refused to unlink: ${failure.message}`,
            now()
          )
          bumpRevision(u)
          return
        }
        for (const a of Object.values(u.state.assignments).filter((a) => a.commandId === id)) {
          // A refused start never took effect; a refused end leaves the role held.
          if (a.change === "start") Object.assign(a, { endedOn: date(), endReason: "Refused by PoliNetwork Auth" })
          else Object.assign(a, { endedOn: null, endReason: null })
          Object.assign(a, { status: "refused", refusal: failure.message, commandId: null })
        }
        log(u, command.personId, command.request.actor, `PoliNetwork Auth refused: ${failure.message}`, now())
        bumpRevision(u)
      })
      return failure.unanswered ? null : failure
    }
    await store.transaction(async (u) => {
      const command = u.state.commands[id]
      if (command?.status !== "queued") return
      Object.assign(command, { status: "applied", answeredAt: now().toISOString(), error: null })
      command.attempts += 1
      const p = u.state.persons[command.personId]
      if (command.purpose === "unlink") {
        if (p) detach(u, p, command.request.actor, command.request.reason)
        bumpRevision(u)
        return
      }
      for (const a of Object.values(u.state.assignments).filter((a) => a.commandId === id))
        Object.assign(a, { status: "applied", refusal: null, commandId: null })
      if (command.request.changes.some((c) => c.kind === "capo" && !c.active))
        clearCapoReferences(u, command.personId, command.request.actor, now())
      log(u, command.personId, command.request.actor, `PoliNetwork Auth confirmed: ${command.request.reason}`, now())
      // What Auth holds afterwards wins, for example a role still held through a parent role. Unless another
      // answer arrived meanwhile: this one may be older, and the next directory read settles it.
      if (p && (u.state.counters.roleRevision ?? 0) === revision) reconcile(u, p, result.roles, result.held, clock())
      bumpRevision(u)
    })
    stale = true
    return null
  }

  /** The single role Auth binds to `binding`, or why People can't use it. */
  function boundRole(directory: RoleDirectory | null, binding: string, action: "assign" | "unassign"): BoundRole {
    if (!directory) fail("PRECONDITION_FAILED", "PoliNetwork Auth isn't configured: People can't change roles")
    const roles = rolesFor(directory.roles, binding)
    if (roles.length > 1) fail("CONFLICT", `More than one role is bound to ${binding} in PoliNetwork Auth.`)
    if (roles[0]) return roles[0]
    // An assignment from before its concept was bound only ever existed in People.
    if (action === "unassign") return { key: "", name: binding, binding, permissions: [] }
    return fail("BAD_REQUEST", `No role is bound to ${binding} in PoliNetwork Auth, so it can't be assigned.`)
  }
  /** The gate for every role change, with the same rules as Auth: see `rules.ts`. */
  function authorize(ctx: Ctx, u: UnitOfWork, v: Viewer, p: Person, binding: string, action: "assign" | "unassign") {
    const role = boundRole(ctx.directory, binding, action)
    const directory = ctx.directory as RoleDirectory
    const problem = peopleRoleChangeProblem({
      actor: v,
      held: bindingsOf(directory.roles, directory.users.find((user) => user.sub === v.sub)?.roles ?? []),
      targetSub: p.accountSub,
      role,
      action,
      unknownPermissions: p.accountSub ? "defer" : "refuse",
    })
    if (problem) fail("FORBIDDEN", problem)
    if (p.accountSub && waiting(u.state, p.id)) fail("CONFLICT", WAITING)
  }

  /** What the record now wants for each concept, as Auth's command expects it. */
  function desired(u: UnitOfWork, p: Person, concepts: Concept[]): RoleCommand["changes"] {
    return concepts.map((concept) => {
      const a = current(u.state, p.id, concept)
      if (concept === "admin" || concept === "capo") return { kind: concept, active: !!a }
      return { kind: "team", team: concept.slice("team:".length) as C.TeamId, role: a?.teamRole ?? null }
    })
  }
  /**
   * After the assignments of `p` changed: a linked record sends them to Auth as one command, acting as `actor`;
   * one that isn't linked keeps them pending.
   */
  function push(u: UnitOfWork, ctx: Ctx, p: Person, changed: Assignment[], actor: string, reason: string) {
    if (!p.accountSub) {
      for (const a of changed) a.status = "pending"
      return
    }
    const id = randomUUID()
    const concepts = [...new Set(changed.map(conceptOf))]
    ctx.send(
      p.id,
      { id, actor, sub: p.accountSub, reason: reason.slice(0, 500), changes: desired(u, p, concepts) },
      true
    )
    for (const a of changed) Object.assign(a, { status: "sent", refusal: null, commandId: id })
  }
  function start(
    u: UnitOfWork,
    v: Viewer,
    p: Person,
    fields: Pick<Assignment, "kind" | "since"> & Partial<Assignment>
  ) {
    if (fields.since > date()) fail("BAD_REQUEST", "Start date is in the future")
    return newAssignment(u.state, { personId: p.id, assignedBy: v.sub, status: "pending", ...fields })
  }
  function end(a: Assignment, reason: string) {
    Object.assign(a, { endedOn: date(), endReason: reason, change: "end" })
    return a
  }
  /** Delivers commands queued for linked records whose pending assignments must now reach Auth. */
  function sendPending(u: UnitOfWork, ctx: Ctx, p: Person, actorOf: (a: Assignment) => string, reason: string) {
    const byActor = new Map<string, Assignment[]>()
    for (const a of assignmentsOf(u.state, p.id))
      if (!a.endedOn && a.status === "pending") byActor.set(actorOf(a), [...(byActor.get(actorOf(a)) ?? []), a])
    // One command per actor, since Auth checks each against whoever acts.
    for (const [actor, assignments] of byActor) {
      const id = randomUUID()
      const concepts = [...new Set(assignments.map(conceptOf))]
      const command = { id, actor, sub: p.accountSub as string, reason: reason.slice(0, 500) }
      ctx.send(p.id, { ...command, changes: desired(u, p, concepts) }, false)
      for (const a of assignments) Object.assign(a, { status: "sent", commandId: id })
    }
  }
  /** A record People created for a role given in Auth, which nobody has worked on since. */
  function automatic(u: UnitOfWork, p: Person) {
    return (
      p.createdBy === "auth" &&
      p.updatedBy === "auth" &&
      !p.notes &&
      !waiting(u.state, p.id) &&
      !Object.values(u.state.invites).some((i) => i.personId === p.id) &&
      !Object.values(u.state.mail).some((m) => m.personId === p.id)
    )
  }
  /**
   * Folds the automatic record of an account into the record being linked to it: its assignments and history
   * move over, and where both have a current assignment for a concept the one Auth holds stays, taking the
   * other's People data. Records made by people are never merged.
   */
  function absorb(u: UnitOfWork, p: Person, other: Person, actor: string) {
    const s = u.state
    for (const a of assignmentsOf(s, other.id)) {
      const mine = a.endedOn ? null : current(s, p.id, conceptOf(a))
      if (mine) {
        a.fields = Object.keys(a.fields).length ? a.fields : mine.fields
        a.capoScope ??= mine.capoScope
        a.capoOfReferenceId ??= mine.capoOfReferenceId === other.id ? null : mine.capoOfReferenceId
        end(mine, "Already held in PoliNetwork Auth")
      }
      a.personId = p.id
    }
    for (const a of Object.values(s.assignments)) if (a.capoOfReferenceId === other.id) a.capoOfReferenceId = p.id
    for (const c of Object.values(s.commands)) if (c.personId === other.id) c.personId = p.id
    p.contactEmail ??= other.contactEmail
    p.telegramUsername ??= other.telegramUsername
    delete s.persons[other.id]
    u.merges.push({ from: other.id, into: p.id })
    log(u, p.id, actor, `Absorbed ${other.id}, created for the account's roles in PoliNetwork Auth`, now())
  }
  function link(u: UnitOfWork, p: Person, sub: string, actor: string, method: "invite" | "manual", how: string) {
    if (p.accountSub) fail("CONFLICT", p.accountSub === sub ? "Already linked" : "Unlink the existing account first")
    const other = Object.values(u.state.persons).find((o) => o.id !== p.id && o.accountSub === sub)
    if (other && !automatic(u, other)) fail("CONFLICT", `This account is already linked to ${other.id}`)
    if (other) {
      other.accountSub = null
      absorb(u, p, other, actor)
    }
    Object.assign(p, { accountSub: sub, linkedAt: now().toISOString(), linkedBy: actor, linkMethod: method })
    for (const invite of Object.values(u.state.invites))
      if (invite.personId === p.id && !invite.revokedAt && !invite.acceptedAt) invite.revokedAt = now().toISOString()
    touch(p, actor, now())
    log(u, p.id, actor, `Linked account ${sub} (${method === "invite" ? "email invite" : "by hand"}): ${how}`, now())
    return p
  }
  /** Auth no longer holds the record's roles: its current assignments wait for the next link, as pending. */
  function detach(u: UnitOfWork, p: Person, actor: string, reason: string) {
    for (const a of assignmentsOf(u.state, p.id))
      if (!a.endedOn) Object.assign(a, { status: "pending", change: "start", refusal: null, commandId: null })
    log(u, p.id, actor, `Unlinked account ${p.accountSub}: ${reason}`, now())
    Object.assign(p, { accountSub: null, linkedAt: null, linkedBy: null, linkMethod: null })
    touch(p, actor, now())
  }
  /** Who may invite to a record: People writers, or the Lead of one of the person's teams. */
  function inviteAccess(ctx: Ctx, u: UnitOfWork, v: Viewer, p: Person) {
    if (general(v, "people:write")) return
    const teams = assignmentsOf(u.state, p.id).flatMap((a) => (a.kind === "team" && !a.endedOn ? [a.team] : []))
    const held = ctx.directory
      ? bindingsOf(ctx.directory.roles, ctx.directory.users.find((user) => user.sub === v.sub)?.roles ?? [])
      : []
    if (!held.some((b) => b.kind === "team" && b.role === "lead" && teams.includes(b.team as C.TeamId)))
      fail("FORBIDDEN", "Inviting needs people:write and admin:access, or leading one of the person's teams")
  }
  function inviteFor(u: UnitOfWork, token: string) {
    const invite = Object.values(u.state.invites).find(
      (i) => i.tokenHash === hash(token) && !i.revokedAt && !i.acceptedAt && i.expiresAt > now().toISOString()
    )
    return invite ?? fail("NOT_FOUND", "This invite link is no longer valid: ask for a new one")
  }

  function capoOf(u: UnitOfWork, capoId: string | null, personId: string) {
    if (!capoId) return null
    const capo = find(u.state, capoId)
    if (capo.id === personId || !confirmedOf(u.state, capo.id, "capo"))
      fail("BAD_REQUEST", "Choose a current Capo Admin")
    return capo.id
  }
  function activeOrFail(u: UnitOfWork, personId: string, concept: Concept, message: string) {
    return current(u.state, personId, concept) ?? fail("CONFLICT", message)
  }
  /** Whether a Lead (per Auth) or a People writer may work on a team's data. */
  function teamAccess(ctx: Ctx, u: UnitOfWork, v: Viewer, team: C.TeamId, write: boolean) {
    if (general(v, write ? "people:write" : "people:read")) return
    const held = ctx.directory
      ? bindingsOf(ctx.directory.roles, ctx.directory.users.find((user) => user.sub === v.sub)?.roles ?? [])
      : []
    const mine = own(u.state, v)
    const leads =
      held.some((b) => b.kind === "team" && b.team === team && b.role === "lead") ||
      (!ctx.directory && !!mine && leadsOf(u.state, mine.id).includes(team))
    if (!v.can("people:self") || !leads) fail("FORBIDDEN", "You do not lead this team")
  }

  return {
    async listPeople(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) => Object.values(u.state.persons).map((p) => row(u.state, p, v)))
    },
    async getPerson(v: Viewer, input: { id: string }) {
      requireGeneral(v, "people:read")
      const activity = await store.activity(input.id)
      return tx((u) => record(u.state, find(u.state, input.id), v, activity))
    },
    async createPerson(v: Viewer, input: C.CreatePersonInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = newPerson(u.state, input, v.sub, now())
        log(u, p.id, v.sub, "Created the record", now())
        return { id: p.id }
      })
    },
    async updatePerson(v: Viewer, input: C.UpdatePersonInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.id)
        Object.assign(p, {
          firstName: input.firstName,
          lastName: input.lastName,
          contactEmail: input.contactEmail || null,
          phone: input.phone || null,
          telegramUsername: input.telegramUsername || null,
        })
        touch(p, v.sub, now())
        log(u, p.id, v.sub, "Updated the record", now())
      })
    },
    async setNote(v: Viewer, input: C.SetNoteInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.id)
        p.notes = input.note || null
        touch(p, v.sub, now())
        log(u, p.id, v.sub, "Updated the HR note", now())
      })
    },

    async listAdmins(v: Viewer): Promise<C.AdminSummary[]> {
      requireGeneral(v, "people:read")
      return tx((u) =>
        Object.values(u.state.persons).flatMap((p) => {
          const admin = current(u.state, p.id, "admin")
          if (!admin) return []
          const capo = current(u.state, p.id, "capo")
          const view = row(u.state, p, v)
          const pick = (a: Assignment | null) => (a ? (view.assignments.find((x) => x.id === a.id) ?? null) : null)
          return [{ person: view, admin: pick(admin) as C.Assignment, capo: pick(capo) }]
        })
      )
    },
    async assignAdmin(v: Viewer, input: C.AssignAdminInput) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        authorize(ctx, u, v, p, "admin", "assign")
        if (current(u.state, p.id, "admin")) fail("CONFLICT", "Already an admin")
        const a = start(u, v, p, {
          kind: "admin",
          since: input.since,
          capoOfReferenceId: capoOf(u, input.capoId, p.id),
        })
        log(u, p.id, v.sub, "Made admin", now())
        push(u, ctx, p, [a], v.sub, "Made admin from People")
      })
    },
    async endAdmin(v: Viewer, input: C.EndAssignmentInput) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        const a = activeOrFail(u, p.id, "admin", "Not a current admin")
        authorize(ctx, u, v, p, "admin", "unassign")
        if (current(u.state, p.id, "capo")) fail("CONFLICT", "End their Capo Admin appointment first")
        end(a, input.reason)
        log(u, p.id, v.sub, `Ended admin: ${input.reason}`, now())
        push(u, ctx, p, [a], v.sub, `Ended admin from People: ${input.reason}`)
      })
    },
    async setCapoOfReference(v: Viewer, input: C.CapoRefInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        const a = activeOrFail(u, p.id, "admin", "Not a current admin")
        a.capoOfReferenceId = capoOf(u, input.capoId, p.id)
        touch(p, v.sub, now())
        log(
          u,
          p.id,
          v.sub,
          input.capoId ? `Capo Admin of reference: ${input.capoId}` : "Cleared the Capo Admin of reference",
          now()
        )
      })
    },

    async listCapos(v: Viewer): Promise<C.CapoSummary[]> {
      requireGeneral(v, "people:read")
      return tx((u) =>
        Object.values(u.state.persons).flatMap((p) => {
          const capo = current(u.state, p.id, "capo")
          if (!capo) return []
          const view = row(u.state, p, v)
          const admins = Object.values(u.state.persons).filter(
            (other) => current(u.state, other.id, "admin")?.capoOfReferenceId === p.id
          )
          return [
            {
              person: view,
              capo: view.assignments.find((x) => x.id === capo.id) as C.Assignment,
              admins: admins.map(ref),
            },
          ]
        })
      )
    },
    async appointCapo(v: Viewer, input: C.AppointCapoInput) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        authorize(ctx, u, v, p, "capo", "assign")
        if (!current(u.state, p.id, "admin")) fail("CONFLICT", "Make them an admin first")
        if (current(u.state, p.id, "capo")) fail("CONFLICT", "Already a Capo Admin")
        const a = start(u, v, p, { kind: "capo", since: input.since, capoScope: input.scope })
        log(u, p.id, v.sub, `Appointed Capo Admin for ${input.scope}`, now())
        push(u, ctx, p, [a], v.sub, `Appointed Capo Admin from People (${input.scope})`)
      })
    },
    async setCapoScope(v: Viewer, input: C.CapoScopeInput) {
      requireGeneral(v, "people:appoint")
      return tx((u) => {
        const p = find(u.state, input.personId)
        activeOrFail(u, p.id, "capo", "Not a current Capo Admin").capoScope = input.scope
        touch(p, v.sub, now())
        log(u, p.id, v.sub, `Capo Admin scope: ${input.scope}`, now())
      })
    },
    async endCapo(v: Viewer, input: C.EndAssignmentInput) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        const a = activeOrFail(u, p.id, "capo", "Not a current Capo Admin")
        authorize(ctx, u, v, p, "capo", "unassign")
        end(a, input.reason)
        // For a linked record, once Auth confirms: a refusal keeps them Capo Admin of the same admins.
        if (!p.accountSub) clearCapoReferences(u, p.id, v.sub, now())
        log(u, p.id, v.sub, `Ended Capo Admin: ${input.reason}`, now())
        push(u, ctx, p, [a], v.sub, `Ended Capo Admin from People: ${input.reason}`)
      })
    },

    async listTeams(v: Viewer): Promise<C.TeamSummary[]> {
      return tx((u, ctx) => {
        const full = general(v, "people:read")
        const allowed = C.TEAM_IDS.filter((team) => {
          if (full) return true
          try {
            teamAccess(ctx, u, v, team, false)
            return true
          } catch {
            return false
          }
        })
        if (!allowed.length) fail("FORBIDDEN", "No readable teams")
        const roles = ctx.directory?.roles ?? []
        return allowed.map((id) => {
          const people = Object.values(u.state.persons).filter((p) =>
            assignmentsOf(u.state, p.id).some((a) => a.team === id && (full || confirmed(a)))
          )
          const lead = people.find((p) => leadsOf(u.state, p.id).includes(id))
          return {
            id,
            name: C.TEAMS[id].name,
            assignable: {
              member: rolesFor(roles, `team:${id}:member`).length === 1,
              lead: rolesFor(roles, `team:${id}:lead`).length === 1,
            },
            lead: lead ? ref(lead) : null,
            members: people.map((p) => {
              const result = row(u.state, p, v, true)
              if (!full) result.assignments = result.assignments.filter((a) => a.team === id && !a.endedOn)
              return result
            }),
          }
        })
      })
    },
    async listTeamCandidates(v: Viewer, input: C.TeamCandidatesInput) {
      return tx((u, ctx) => {
        teamAccess(ctx, u, v, input.teamId, false)
        return Object.values(u.state.persons)
          .filter((p) => !current(u.state, p.id, `team:${input.teamId}`))
          .map(ref)
      })
    },
    async addTeamMember(v: Viewer, input: C.AddTeamMemberInput) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        authorize(ctx, u, v, p, `team:${input.teamId}:${input.role}`, "assign")
        validateFields(input.teamId, input.fields)
        if (current(u.state, p.id, `team:${input.teamId}`)) fail("CONFLICT", "Already in this team")
        if (
          input.role === "lead" &&
          Object.values(u.state.persons).some(
            (o) => current(u.state, o.id, `team:${input.teamId}`)?.teamRole === "lead"
          )
        )
          fail("CONFLICT", "End the existing Lead appointment first")
        const a = start(u, v, p, {
          kind: "team",
          team: input.teamId,
          teamRole: input.role,
          since: input.since,
          fields: input.fields,
        })
        log(u, p.id, v.sub, `Joined ${input.teamId} as ${input.role}`, now())
        push(u, ctx, p, [a], v.sub, `Joined ${input.teamId} as ${input.role} from People`)
      })
    },
    async updateTeamFields(v: Viewer, input: C.TeamFieldsInput) {
      return tx((u, ctx) => {
        teamAccess(ctx, u, v, input.teamId, true)
        validateFields(input.teamId, input.fields)
        const p = find(u.state, input.personId)
        activeOrFail(u, p.id, `team:${input.teamId}`, "Not in this team").fields = input.fields
        touch(p, v.sub, now())
        log(u, p.id, v.sub, `Updated ${input.teamId} fields`, now())
      })
    },
    async endTeamMembership(v: Viewer, input: C.EndTeamInput) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        const a = activeOrFail(u, p.id, `team:${input.teamId}`, "Not in this team")
        authorize(ctx, u, v, p, `team:${input.teamId}:${a.teamRole}`, "unassign")
        end(a, input.reason)
        log(u, p.id, v.sub, `Left ${input.teamId}: ${input.reason}`, now())
        push(u, ctx, p, [a], v.sub, `Left ${input.teamId} from People: ${input.reason}`)
      })
    },

    async listInvites(v: Viewer): Promise<C.Invite[]> {
      requireGeneral(v, "people:read")
      return tx((u) =>
        Object.values(u.state.persons).flatMap((p) => {
          const invite = p.accountSub ? null : openInvite(u.state, p.id)
          return invite
            ? [
                {
                  personId: p.id,
                  name: nameOf(p),
                  email: invite.email,
                  sentOn: invite.sentAt.slice(0, 10),
                  expiresOn: invite.expiresAt.slice(0, 10),
                  sentBy: invite.sentBy,
                },
              ]
            : []
        })
      )
    },
    async sendInvite(v: Viewer, input: { personId: string }) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        inviteAccess(ctx, u, v, p)
        if (p.accountSub || !p.contactEmail) fail("CONFLICT", "Account already linked or contact email missing")
        const previous = openInvite(u.state, p.id)
        if (previous) previous.revokedAt = now().toISOString()
        const token = randomBytes(32).toString("base64url")
        const invite = {
          id: randomUUID(),
          personId: p.id,
          tokenHash: hash(token),
          email: p.contactEmail,
          sentBy: v.sub,
          sentAt: now().toISOString(),
          expiresAt: new Date(now().getTime() + 14 * 86_400_000).toISOString(),
          revokedAt: null,
          acceptedAt: null,
          acceptedBy: null,
        }
        u.state.invites[invite.id] = invite
        queueMail(
          u.state,
          p.id,
          `invite:${invite.id}`,
          p.contactEmail,
          "PoliNetwork · collega il tuo account",
          inviteText(p, `${dashboardUrl}/dashboard/account/me?peopleInvite=${token}`, invite.expiresAt)
        )
        log(u, p.id, v.sub, "Queued an account invite", now())
      })
    },
    async revokeInvite(v: Viewer, input: { personId: string }) {
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        inviteAccess(ctx, u, v, p)
        const invite = openInvite(u.state, p.id) ?? fail("CONFLICT", "No open invite")
        invite.revokedAt = now().toISOString()
        log(u, p.id, v.sub, "Revoked the account invite", now())
      })
    },
    async searchAccounts(v: Viewer, input: C.SearchAccountsInput): Promise<C.AccountMatch[]> {
      requireGeneral(v, "people:link")
      const accounts = await options.directory()
      return tx((u) => {
        const q = input.query.toLowerCase()
        return accounts
          .filter((a) => !q || `${a.name} ${a.email ?? ""} ${a.sub}`.toLowerCase().includes(q))
          .slice(0, 100)
          .map((a) => {
            const linked = Object.values(u.state.persons).find((p) => p.accountSub === a.sub)
            return { id: a.sub, name: a.name, email: a.email ?? "", linkedTo: linked ? ref(linked) : null }
          })
      })
    },
    /** Links by hand, then sends the record's pending assignments to Auth acting as whoever linked it. */
    async linkAccount(v: Viewer, input: C.LinkAccountInput) {
      requireGeneral(v, "people:link")
      const account = (await options.directory()).find((a) => a.sub === input.accountId)
      if (!account) fail("NOT_FOUND", "IdP account not found")
      // Its pending assignments would be sent as self-grants, which Auth refuses.
      if (account.sub === v.sub) fail("FORBIDDEN", "Ask someone else to link your own account")
      return tx((u, ctx) => {
        const p = link(u, find(u.state, input.personId), account.sub, v.sub, "manual", input.reason)
        sendPending(u, ctx, p, () => v.sub, `Linked from People: ${input.reason}`)
      })
    },
    /**
     * Takes the record's roles back from the account in Auth, then detaches it; its assignments go back to
     * `pending` for the next link. Without roles Auth holds, it detaches at once.
     */
    async unlinkAccount(v: Viewer, input: C.UnlinkAccountInput) {
      requireGeneral(v, "people:link")
      return tx((u, ctx) => {
        const p = find(u.state, input.personId)
        if (!p.accountSub) fail("CONFLICT", "Account not linked")
        if (waiting(u.state, p.id)) fail("CONFLICT", WAITING)
        const held = assignmentsOf(u.state, p.id).filter(
          (a) => !a.endedOn && !!ctx.directory && isBound(ctx.directory.roles, conceptOf(a))
        )
        for (const a of held) {
          const binding = a.kind === "team" ? `team:${a.team}:${a.teamRole}` : a.kind
          authorize(ctx, u, v, p, binding, "unassign")
        }
        if (!held.length) return detach(u, p, v.sub, input.reason)
        const id = randomUUID()
        const changes = desired(u, p, [...new Set(held.map(conceptOf))]).map((c) =>
          c.kind === "team" ? { ...c, role: null } : { ...c, active: false }
        )
        const reason = `Unlinked from People: ${input.reason}`.slice(0, 500)
        ctx.send(p.id, { id, actor: v.sub, sub: p.accountSub, reason, changes }, true, "unlink")
        for (const a of held) Object.assign(a, { status: "sent", refusal: null, commandId: id })
        log(u, p.id, v.sub, "Asked PoliNetwork Auth to take the record's roles back before unlinking", now())
      })
    },
    async listRecentLinks(v: Viewer): Promise<C.RecentLink[]> {
      requireGeneral(v, "people:read")
      const accounts = await options.directory().catch(() => [] as Account[])
      const since = new Date(now().getTime() - 30 * 86_400_000).toISOString()
      return tx((u) =>
        Object.values(u.state.persons)
          .filter((p) => p.accountSub && p.linkedAt && p.linkedAt >= since)
          .sort((a, b) => ((a.linkedAt as string) < (b.linkedAt as string) ? 1 : -1))
          .map((p) => ({
            person: ref(p),
            sub: p.accountSub as string,
            email: accounts.find((a) => a.sub === p.accountSub)?.email ?? null,
            method: p.linkMethod ?? "manual",
            linkedOn: (p.linkedAt as string).slice(0, 10),
            linkedBy: p.linkedBy,
          }))
      )
    },
    /**
     * Links the signed-in account to the invited record. Each pending assignment is sent acting as whoever made
     * it: Auth refuses self-grants, so the invitee can't be the actor.
     */
    /** The record an invite is for, so the landing page can ask "Link this account to <name>?". */
    async previewInvite(_v: Viewer, input: { token: string }): Promise<C.InvitePreview> {
      return tx((u) => {
        const invite = inviteFor(u, input.token)
        const p = find(u.state, invite.personId)
        return { personId: p.id, name: nameOf(p), expiresOn: invite.expiresAt.slice(0, 10) }
      })
    },
    /**
     * Any signed-in account may accept: the single-use token is the proof, not the account's email, since people
     * often sign in with another account than the one we know. Recently linked lists it, in case an invite was
     * forwarded.
     */
    async acceptInvite(v: Viewer, input: { token: string }) {
      return tx((u, ctx) => {
        const invite = inviteFor(u, input.token)
        const p = link(u, find(u.state, invite.personId), v.sub, v.sub, "invite", "Accepted the email invite")
        Object.assign(invite, { revokedAt: null, acceptedAt: now().toISOString(), acceptedBy: v.sub })
        sendPending(u, ctx, p, (a) => a.assignedBy, "Linked by accepting an invite in People")
      })
    },

    async getMyRoles(v: Viewer): Promise<C.MyRoles> {
      requireSelf(v)
      return tx((u) => {
        const p = own(u.state, v)
        return {
          capoScope: p ? (confirmedOf(u.state, p.id, "capo")?.capoScope ?? null) : null,
          leads: p ? leadsOf(u.state, p.id) : [],
        }
      })
    },
    async getMyArea(v: Viewer): Promise<C.MyArea> {
      requireSelf(v)
      const mine = await tx((u) => own(u.state, v))
      if (!mine) return { state: "none" }
      const activity = await store.activity(mine.id)
      return tx((u) => {
        const p = own(u.state, v)
        if (!p) return { state: "none" }
        const teams = assignmentsOf(u.state, p.id).flatMap((a) =>
          a.kind === "team" && confirmed(a) ? [a.team as C.TeamId] : []
        )
        const contacts: Extract<C.MyArea, { state: "linked" }>["contacts"] = []
        const capoId = confirmedOf(u.state, p.id, "admin")?.capoOfReferenceId
        const capo = capoId && confirmedOf(u.state, capoId, "capo") ? u.state.persons[capoId] : null
        if (capo) contacts.push({ role: "capo", name: nameOf(capo), telegram: capo.telegramUsername, team: null })
        for (const other of Object.values(u.state.persons)) {
          for (const team of leadsOf(u.state, other.id).filter((team) => teams.includes(team)))
            contacts.push({ role: "lead", name: nameOf(other), telegram: other.telegramUsername, team })
          if (confirmedOf(u.state, other.id, "team:hr"))
            contacts.push({ role: "hr", name: nameOf(other), telegram: other.telegramUsername, team: "hr" })
        }
        const team = teams[0]
        return {
          state: "linked",
          person: record(u.state, p, v, activity),
          contacts,
          roster: team
            ? {
                team,
                members: Object.values(u.state.persons).flatMap((other) => {
                  const a = confirmedOf(u.state, other.id, `team:${team}`)
                  return a
                    ? [{ ...ref(other), role: a.teamRole as "member" | "lead", telegram: other.telegramUsername }]
                    : []
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
        const scope = confirmedOf(u.state, p.id, "capo")?.capoScope
        if (!scope) fail("FORBIDDEN", "You are not a current Capo Admin")
        return {
          scope,
          admins: Object.values(u.state.persons)
            .filter((other) => confirmedOf(u.state, other.id, "admin")?.capoOfReferenceId === p.id)
            .map((other) => ({ ...row(u.state, other, v, true), contactEmail: null, phone: null })),
        }
      })
    },

    /** Sends queued mail and role commands; the cron calls it every minute. */
    async deliverPending() {
      const commands = await store.transaction(async (u) =>
        Object.values(u.state.commands)
          .filter((c) => c.status === "queued")
          .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
          .slice(0, 20)
          .map((c) => c.id)
      )
      for (const id of commands) await deliver(id)

      // Claim and record intent before network I/O. Unknown outcomes require an explicit retry.
      const claimed = await store.transaction(async (u) => {
        for (const mail of Object.values(u.state.mail))
          if (
            mail.status === "sending" &&
            mail.attemptedAt &&
            now().getTime() - Date.parse(mail.attemptedAt) > 10 * 60000
          ) {
            mail.status = "failed"
            mail.error = "Delivery outcome unknown after interruption; check the mailbox before retrying"
          }
        const pending = Object.values(u.state.mail)
          .filter((m) => m.status === "pending")
          .slice(0, 20)
        for (const mail of pending) {
          mail.status = "sending"
          mail.attemptedAt = now().toISOString()
        }
        return structuredClone(pending)
      })
      for (const mail of claimed) {
        let error: string | null = null
        try {
          await options.sendMail({ id: mail.id, to: mail.to, subject: mail.subject, text: mail.text })
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
        await store.transaction(async (u) => {
          const current = u.state.mail[mail.id]
          if (current.status !== "sending" || current.attemptedAt !== mail.attemptedAt) return
          current.status = error ? "failed" : "sent"
          current.error = error
          log(u, mail.personId, "system", error ? `Email failed: ${error}` : `Sent email: ${mail.subject}`, now())
        })
      }
    },
  }
}
export type PeopleService = ReturnType<typeof createPeopleService>
