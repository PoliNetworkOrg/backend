import { createHash, randomBytes, randomUUID } from "node:crypto"
import { TRPCError } from "@trpc/server"
import type { z } from "zod"
import type { Command, createSchema, Event, Member, Profile, Request } from "./contract"

export type Viewer = { sub: string; name: string; operator: boolean; email?: string }
export type Invitation = { requestId: string; hash: string; expiresAt: string }
export type Record = {
  id: string
  legacyId: number | null
  revision: number
  creator: string
  registered: boolean
  status: "pending" | "active" | "suspended" | "archived"
  profile: Profile
  published: Profile | null
  members: Member[]
  requests: Request[]
  events: Event[]
  invitations: Invitation[]
  notes: string
  commands: string[]
}
export type Mail = { id: string; to: string; subject: string; text: string }
export type Store = {
  list(): Promise<Record[]>
  get(id: string): Promise<Record | null>
  byInvitation(hash: string): Promise<Record | null>
  published(): Promise<Record[]>
  recentAccessRequests(sub: string, since: string): Promise<number>
  create(record: Record, commandId: string, actor: string): Promise<string>
  transfer<T>(from: string, to: string, operation: (source: Record, destination: Record) => T): Promise<T>
  change<T>(id: string, operation: (record: Record, mail: Mail[]) => T): Promise<T>
}
function fail(
  code: "FORBIDDEN" | "NOT_FOUND" | "CONFLICT" | "BAD_REQUEST" | "TOO_MANY_REQUESTS",
  message: string
): never {
  throw new TRPCError({ code, message })
}
const MAX_COMMAND_KEYS = 200
const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const activeMember = (r: Record, v: Viewer) => r.members.find((m) => m.sub === v.sub && m.active)
const accessible = (r: Record, v: Viewer) =>
  v.operator ||
  !!activeMember(r, v) ||
  r.creator === v.sub ||
  r.requests.some((q) => q.by === v.sub || q.targetSub === v.sub)
const writable = (r: Record, v: Viewer) => v.operator || (r.status === "active" && !!activeMember(r, v))
const responsible = (r: Record, v: Viewer) =>
  v.operator || (r.status === "active" && activeMember(r, v)?.role === "responsible")
const operator = (v: Viewer) => {
  if (!v.operator) fail("FORBIDDEN", "PoliNetwork approval is required")
}
const event = (r: Record, v: Viewer, action: string, detail = "", requestId?: string) =>
  r.events.push({ id: randomUUID(), at: new Date().toISOString(), actor: v.name, action, detail, requestId })
function request(v: Viewer, kind: Request["kind"], explanation: string, profile: Profile | null = null): Request {
  const now = new Date().toISOString()
  return {
    id: randomUUID(),
    redirectId: null,
    kind,
    status: "draft",
    by: v.sub,
    byName: v.name,
    explanation,
    response: "",
    profile,
    targetSub: null,
    targetName: null,
    targetEmail: "",
    role: "responsible",
    email: v.email ?? "",
    remove: false,
    accepted: false,
    createdAt: now,
    updatedAt: now,
    decidedBy: null,
  }
}
function validatePublication(p: Profile) {
  if (!p.descriptionIt.trim() || !p.descriptionEn.trim())
    fail("BAD_REQUEST", "Complete both descriptions before submitting the public profile")
}
function summary(r: Record, v: Viewer) {
  return {
    id: r.id,
    name: r.profile.name,
    status: r.status,
    registered: r.registered,
    published: !!r.published,
    role: activeMember(r, v)?.role ?? null,
    pending: r.requests.filter((q) => q.status === "submitted" && (v.operator || q.by === v.sub)).length,
    unrepresented: !r.members.some((m) => m.active && m.role === "responsible"),
  }
}
export function present(r: Record, v: Viewer) {
  if (!accessible(r, v)) fail("NOT_FOUND", "Association not found")
  const member = !!activeMember(r, v)
  // A claimant sees their own application, never another claimant's evidence or the private working profile.
  const requests = r.requests.filter(
    (q) => v.operator || q.by === v.sub || q.targetSub === v.sub || (member && q.kind === "content")
  )
  return {
    ...summary(r, v),
    revision: r.revision,
    profile:
      v.operator || member || (!r.registered && r.creator === v.sub)
        ? r.profile
        : (r.published ?? { ...r.profile, descriptionIt: "", descriptionEn: "", email: "", links: [], logo: null }),
    publishedProfile: r.published,
    members: v.operator || member ? r.members : [],
    requests,
    events: r.events.filter(
      (e) =>
        v.operator ||
        (e.requestId ? requests.some((q) => q.id === e.requestId) : member && e.action !== "Internal note updated")
    ),
    notes: v.operator ? r.notes : null,
    canEdit: writable(r, v),
    canSubmit: responsible(r, v),
    canManage: responsible(r, v),
    operator: v.operator,
  }
}
export function createAssociationService(store: Store, dashboardUrl: string) {
  return {
    async list(v: Viewer) {
      const records = (await store.list()).filter((r) => accessible(r, v))
      return {
        operator: v.operator,
        associations: records.map((r) => summary(r, v)),
        requests: records.flatMap((r) =>
          present(r, v).requests.map((q) => ({ ...q, associationId: r.id, associationName: r.profile.name }))
        ),
      }
    },
    async directory() {
      return (await store.list())
        .filter((r) => r.registered && r.status === "active")
        .map((r) => ({ id: r.id, name: r.profile.name, revision: r.revision }))
    },
    async get(v: Viewer, id: string) {
      const r = await store.get(id)
      if (!r) return fail("NOT_FOUND", "Association not found")
      return present(r, v)
    },
    async create(v: Viewer, input: z.infer<typeof createSchema>) {
      const q = request(v, "registration", input.explanation, input.profile)
      q.status = input.submit ? "submitted" : "draft"
      q.targetSub = v.operator ? null : v.sub
      q.targetName = v.operator ? null : v.name
      q.accepted = !v.operator
      const r: Record = {
        id: randomUUID(),
        legacyId: null,
        revision: 0,
        creator: v.sub,
        registered: false,
        status: "pending",
        profile: input.profile,
        published: null,
        members: [],
        requests: [q],
        events: [],
        invitations: [],
        notes: "",
        commands: [],
      }
      if (v.operator && input.submit) {
        r.registered = true
        r.status = "active"
        r.requests = []
      }
      event(
        r,
        v,
        v.operator && input.submit
          ? "Association registered by PoliNetwork"
          : input.submit
            ? "Registration submitted"
            : "Registration draft saved"
      )
      return { id: await store.create(r, input.commandId, v.sub) }
    },
    async command(v: Viewer, c: Command) {
      if (c.action === "redirect") {
        operator(v)
        if (c.id === c.destinationId) fail("BAD_REQUEST", "Choose a different association")
        return store.transfer(c.id, c.destinationId, (source, destination) => {
          const key = `${v.sub}:${c.commandId}`
          if (source.commands.includes(key)) return { id: destination.id }
          if (source.revision !== c.revision) fail("CONFLICT", "Reload the request before continuing")
          const q = source.requests.find(
            (q) => q.id === c.requestId && q.kind === "registration" && q.status === "submitted"
          )
          if (!q || source.registered || !destination.registered || destination.status !== "active")
            fail("CONFLICT", "Only an unapproved registration can be redirected to an active association")
          const forwarded = {
            ...q,
            id: randomUUID(),
            kind: "access" as const,
            profile: null,
            response: "",
            decidedBy: null,
          }
          if (destination.members.some((m) => m.sub === q.targetSub && m.active))
            fail("CONFLICT", "The applicant already has access")
          destination.requests.push(forwarded)
          q.status = "withdrawn"
          q.response = c.reason
          q.decidedBy = v.name
          q.redirectId = destination.id
          source.status = "archived"
          source.commands.push(key)
          source.revision++
          destination.revision++
          event(source, v, "Registration redirected", c.reason, q.id)
          event(destination, v, "Access request received from an existing application", "", forwarded.id)
          return { id: destination.id }
        })
      }
      if (c.action === "access" && !v.operator) {
        const since = new Date(Date.now() - 86400000).toISOString()
        if ((await store.recentAccessRequests(v.sub, since)) >= 20)
          fail("TOO_MANY_REQUESTS", "Too many access requests today. Contact PoliNetwork.")
      }
      return store.change(c.id, (r, mail) => {
        // Recheck authorization before idempotency: a former representative cannot reuse commands to read the record.
        if (c.action !== "access" && !accessible(r, v)) fail("NOT_FOUND", "Association not found")
        const commandKey = `${v.sub}:${c.commandId}`
        if (r.commands.includes(commandKey)) return { id: r.id }
        if (r.revision !== c.revision) fail("CONFLICT", "The association changed. Reload before continuing.")
        if (
          ["access", "invite", "membership"].includes(c.action) &&
          !v.operator &&
          r.requests.filter((q) => q.by === v.sub && Date.parse(q.createdAt) > Date.now() - 86400000).length >= 20
        )
          fail("TOO_MANY_REQUESTS", "Too many requests today. Contact PoliNetwork.")
        if (c.action === "save") {
          let q = c.requestId ? r.requests.find((q) => q.id === c.requestId) : undefined
          if (q && q.kind !== "registration" && q.kind !== "content")
            fail("BAD_REQUEST", "This request has no editable profile")
          if (q?.kind === "registration") {
            if (q.by !== v.sub || r.registered) fail("FORBIDDEN", "Only the applicant can edit this request")
          } else if (!writable(r, v)) fail("FORBIDDEN", "You cannot edit this association")
          if (q && !["draft", "changes"].includes(q.status))
            fail("CONFLICT", "Withdraw the submitted request before editing")
          if (!q) {
            if (c.requestId) fail("NOT_FOUND", "Request not found")
            if (r.requests.some((q) => q.kind === "content" && ["draft", "changes", "submitted"].includes(q.status)))
              fail("CONFLICT", "There is already a working profile")
            q = request(v, "content", c.explanation, c.profile)
            r.requests.push(q)
          }
          q.profile = c.profile
          q.explanation = c.explanation
          q.updatedAt = new Date().toISOString()
          if (!r.registered) r.profile = c.profile
          event(r, v, "Draft saved", "", q.id)
        } else if (c.action === "reply") {
          const q = r.requests.find((q) => q.id === c.requestId)
          if (!q || q.by !== v.sub || q.status !== "changes" || q.profile !== null)
            fail("FORBIDDEN", "Only the applicant can answer a request for information")
          q.explanation = c.explanation
          q.status = "submitted"
          q.updatedAt = new Date().toISOString()
          event(r, v, "Requested information supplied", "", q.id)
        } else if (c.action === "submit" || c.action === "withdraw") {
          const q = r.requests.find((q) => q.id === c.requestId)
          if (!q) fail("NOT_FOUND", "Request not found")
          if (q.kind === "content" ? !responsible(r, v) : q.by !== v.sub && !v.operator)
            fail("FORBIDDEN", "You cannot submit this request")
          if (c.action === "submit") {
            if (!["draft", "changes"].includes(q.status)) fail("CONFLICT", "This request cannot be submitted")
            if (!q.explanation.trim()) fail("BAD_REQUEST", "Explain the request before submitting")
            if (q.kind === "content" && q.profile) validatePublication(q.profile)
            q.status = "submitted"
          } else {
            if (!["draft", "changes", "submitted"].includes(q.status))
              fail("CONFLICT", "This request is already closed")
            q.status = "withdrawn"
            r.invitations = r.invitations.filter((i) => i.requestId !== q.id)
          }
          q.updatedAt = new Date().toISOString()
          event(r, v, c.action === "submit" ? "Request submitted" : "Request withdrawn", "", q.id)
        } else if (c.action === "access") {
          if (!r.registered || r.status !== "active" || activeMember(r, v))
            fail("FORBIDDEN", "This association is not available for an access request")
          if (
            r.requests.some((q) => q.by === v.sub && q.kind === "access" && ["submitted", "changes"].includes(q.status))
          )
            fail("CONFLICT", "You already have an open access request")
          const q = request(v, "access", c.explanation)
          q.status = "submitted"
          q.targetSub = v.sub
          q.targetName = v.name
          q.accepted = true
          r.requests.push(q)
          event(r, v, "Access requested", "", q.id)
        } else if (c.action === "invite" || c.action === "membership") {
          if (!responsible(r, v) || !r.registered) fail("FORBIDDEN", "Only a responsible can propose representatives")
          const q = request(v, "membership", c.explanation)
          q.status = "submitted"
          q.role = c.role
          if (c.action === "invite") {
            if (
              r.requests.some(
                (q) =>
                  q.email.toLowerCase() === c.email.toLowerCase() && q.kind === "membership" && q.status === "submitted"
              )
            )
              fail("CONFLICT", "An invitation is already pending for this address")
            q.email = c.email
            const token = randomBytes(32).toString("base64url")
            r.invitations.push({
              requestId: q.id,
              hash: hash(token),
              expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(),
            })
            mail.push({
              id: randomUUID(),
              to: c.email,
              subject: `Invito — ${r.profile.name}`,
              text: `Sei stato invitato come referente di ${r.profile.name}. Accetta con il tuo account personale; PoliNetwork dovrà poi approvare il collegamento. L'invito scade fra 14 giorni.\n${dashboardUrl}/associations/invite?token=${token}`,
            })
          } else {
            const member = r.members.find((m) => m.sub === c.sub && m.active)
            if (!member) fail("NOT_FOUND", "Representative not found")
            q.targetSub = member.sub
            q.targetName = member.name
            q.accepted = true
            q.remove = c.remove
          }
          r.requests.push(q)
          event(r, v, "Representative change requested", "", q.id)
        } else if (c.action === "review") {
          operator(v)
          const q = r.requests.find((q) => q.id === c.requestId)
          if (!q || q.status !== "submitted") fail("CONFLICT", "The request is not awaiting review")
          if (c.decision === "approve") {
            if (r.status === "archived" || r.status === "suspended")
              fail("CONFLICT", "Reactivate the association before approving changes")
            if (q.kind === "content") {
              if (!r.registered || !q.profile) fail("BAD_REQUEST", "Register the association first")
              validatePublication(q.profile)
              r.profile = q.profile
              r.published = q.profile
            } else {
              if (q.kind !== "registration" && (!q.accepted || !q.targetSub))
                fail("BAD_REQUEST", "The invited person must accept before approval")
              if (q.kind === "registration") {
                if (r.registered) fail("CONFLICT", "Already registered")
                r.registered = true
                r.status = "active"
                if (q.profile) r.profile = q.profile
              }
              const target = r.members.find((m) => m.sub === q.targetSub)
              if (
                (q.remove || q.role !== "responsible") &&
                target?.active &&
                target.role === "responsible" &&
                !r.members.some((m) => m.active && m.role === "responsible" && m.sub !== target.sub)
              )
                fail("CONFLICT", "Approve a replacement responsible first; use explicit revocation for urgent removal")
              if (q.targetSub && target) {
                target.role = q.role
                target.active = !q.remove
              } else if (q.targetSub)
                r.members.push({ sub: q.targetSub, name: q.targetName ?? q.targetSub, role: q.role, active: true })
            }
          }
          q.status = c.decision === "approve" ? "approved" : c.decision === "changes" ? "changes" : "rejected"
          q.response = c.reason
          q.decidedBy = v.name
          q.updatedAt = new Date().toISOString()
          if (q.status !== "changes") r.invitations = r.invitations.filter((i) => i.requestId !== q.id)
          if (q.email)
            mail.push({
              id: randomUUID(),
              to: q.email,
              subject: `Aggiornamento richiesta — ${r.profile.name}`,
              text: `La richiesta per ${r.profile.name} è stata aggiornata: ${q.status}. Accedi con il tuo account per leggere la risposta di PoliNetwork.\n${dashboardUrl}/dashboard/associations/${r.id}`,
            })
          event(r, v, `Request ${q.status}`, c.reason, q.id)
        } else if (c.action === "status") {
          operator(v)
          if (!r.registered) fail("BAD_REQUEST", "Review registration first")
          r.status = c.status
          if (c.hide || c.status === "archived") r.published = null
          event(r, v, `Association ${c.status}`, c.reason)
        } else if (c.action === "unpublish") {
          operator(v)
          r.published = null
          event(r, v, "Profile unpublished", c.reason)
        } else if (c.action === "note") {
          operator(v)
          r.notes = c.note
          event(r, v, "Internal note updated")
        } else if (c.action === "leave" || c.action === "revoke") {
          if (c.action === "revoke") operator(v)
          const member = r.members.find((m) => m.sub === (c.action === "leave" ? v.sub : c.sub) && m.active)
          if (!member) fail("NOT_FOUND", "Active representative not found")
          member.active = false
          // A pending approval must not silently bring a removed representative back.
          for (const pending of r.requests)
            if (
              pending.targetSub === member.sub &&
              (pending.kind === "membership" || pending.kind === "access") &&
              ["submitted", "changes"].includes(pending.status)
            ) {
              pending.status = "withdrawn"
              pending.response = "Representative removed"
              pending.updatedAt = new Date().toISOString()
              r.invitations = r.invitations.filter((i) => i.requestId !== pending.id)
            }
          event(r, v, c.action === "leave" ? "Representative left" : "Representative revoked", c.reason)
        }
        r.commands.push(commandKey)
        // Retries only matter for a short window; keep the aggregate from growing without bound.
        if (r.commands.length > MAX_COMMAND_KEYS) r.commands.splice(0, r.commands.length - MAX_COMMAND_KEYS)
        r.revision++
        return { id: r.id }
      })
    },
    async invitation(token: string) {
      const r = await store.byInvitation(hash(token))
      const i = r?.invitations.find((i) => i.hash === hash(token) && i.expiresAt > new Date().toISOString())
      const q = r?.requests.find((q) => q.id === i?.requestId)
      if (!r || !i || !q || !["submitted", "changes"].includes(q.status) || r.status !== "active")
        fail("NOT_FOUND", "Invitation expired or revoked")
      return { associationName: r.profile.name, role: q.role, expiresAt: i.expiresAt }
    },
    async accept(v: Viewer, token: string) {
      const r = await store.byInvitation(hash(token))
      if (!r) fail("NOT_FOUND", "Invitation expired or revoked")
      return store.change(r.id, (r) => {
        const i = r.invitations.find((i) => i.hash === hash(token))
        const q = r.requests.find((q) => q.id === i?.requestId)
        if (
          !i ||
          !q ||
          i.expiresAt <= new Date().toISOString() ||
          !["submitted", "changes"].includes(q.status) ||
          r.status !== "active"
        )
          fail("NOT_FOUND", "Invitation expired or revoked")
        if (activeMember(r, v)) fail("CONFLICT", "You already represent this association")
        q.targetSub = v.sub
        q.targetName = v.name
        q.accepted = true
        q.status = "submitted"
        q.updatedAt = new Date().toISOString()
        r.invitations = r.invitations.filter((candidate) => candidate !== i)
        r.revision++
        q.targetEmail = v.email ?? ""
        event(
          r,
          v,
          "Invitation accepted; awaiting PoliNetwork",
          `Invited address: ${q.email}; accepting account: ${v.email ?? "unknown"}`,
          q.id
        )
        return { id: r.id }
      })
    },
  }
}
