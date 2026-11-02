import * as C from "./contract"
import { clearCapoReferences, current, log, newAssignment, nextPersonId, waiting } from "./model"
import { type Concept, isBound, type RoleDirectory, rolesFor, sinceOf, viewOf } from "./roles"
import type { BoundRole } from "./rules"
import type { PeopleState, Person, UnitOfWork } from "./types"

type Clock = { date: string; now: Date }
const CONCEPTS: Concept[] = ["admin", "capo", ...C.TEAM_IDS.map((team) => `team:${team}` as const)]
const LABEL = { admin: "admin", capo: "Capo Admin" }

/**
 * Brings a linked record in line with what PoliNetwork Auth holds: an assignment is current exactly while
 * its role is held, so one whose concept no longer has a bound role ends too. A record with a change still
 * waiting for Auth is left alone until Auth answers.
 */
export function reconcile(
  u: UnitOfWork,
  p: Person,
  roles: readonly BoundRole[],
  held: readonly string[],
  at: Clock,
  since?: Record<string, string>
) {
  const s = u.state
  if (!p.accountSub || waiting(s, p.id)) return
  const view = viewOf(roles, held)
  const end = (a: ReturnType<typeof current>, reason: string) => {
    if (!a) return
    Object.assign(a, {
      endedOn: at.date,
      endReason: reason,
      change: "end",
      status: "applied",
      refusal: null,
      commandId: null,
    })
  }
  for (const concept of CONCEPTS) {
    const a = current(s, p.id, concept)
    if (!isBound(roles, concept)) {
      if (!a) continue
      end(a, "No role is bound to it in PoliNetwork Auth")
      if (concept === "capo") clearCapoReferences(u, p.id, "system", at.now)
      log(u, p.id, "system", `Ended ${concept}: no role is bound to it in PoliNetwork Auth`, at.now)
      continue
    }
    if (concept === "admin" || concept === "capo") {
      if (view[concept] && !a) {
        newAssignment(s, {
          personId: p.id,
          kind: concept,
          since: sinceOf(
            rolesFor(roles, concept).map((r) => r.key),
            since,
            at.date
          ),
          assignedBy: "auth",
          status: "applied",
        })
        log(u, p.id, "system", `Became ${LABEL[concept]}: held in PoliNetwork Auth`, at.now)
      } else if (!view[concept] && a) {
        end(a, "Not held in PoliNetwork Auth")
        if (concept === "capo") clearCapoReferences(u, p.id, "system", at.now)
        log(u, p.id, "system", `Ended ${LABEL[concept]}: not held in PoliNetwork Auth`, at.now)
      } else if (a?.status === "pending") a.status = "applied"
      continue
    }
    const team = concept.slice("team:".length) as C.TeamId
    const role = view.teams[team]
    if (a && a.teamRole !== role) {
      end(a, role ? "Changed in PoliNetwork Auth" : "Not held in PoliNetwork Auth")
      if (!role) log(u, p.id, "system", `Left ${team}: not held in PoliNetwork Auth`, at.now)
    }
    if (role && (!a || a.teamRole !== role)) {
      newAssignment(s, {
        personId: p.id,
        kind: "team",
        team,
        teamRole: role,
        fields: a?.fields ?? {},
        since: sinceOf(
          rolesFor(roles, `team:${team}:${role}`).map((r) => r.key),
          since,
          at.date
        ),
        assignedBy: "auth",
        status: "applied",
      })
      log(u, p.id, "system", `Joined ${team} as ${role}: held in PoliNetwork Auth`, at.now)
    } else if (a?.status === "pending") a.status = "applied"
  }
}

function splitName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  return { firstName: parts.shift() ?? "?", lastName: parts.join(" ") }
}

/**
 * Lays Auth's answer over the register:
 * - someone holding a bound role without a record (e.g. assigned by hand in Auth) gets one, already linked;
 * - every linked record follows the roles Auth holds for its account, none when Auth doesn't list it.
 * Records that aren't linked are People's alone.
 */
export function syncDirectory(u: UnitOfWork, directory: RoleDirectory, at: Clock) {
  const s: PeopleState = u.state
  const bySub = new Map(Object.values(s.persons).flatMap((p) => (p.accountSub ? [[p.accountSub, p] as const] : [])))
  const listed = new Set<string>()
  for (const user of directory.users) {
    listed.add(user.sub)
    let p = bySub.get(user.sub)
    if (!p) {
      const view = viewOf(directory.roles, user.roles)
      if (!view.admin && !view.capo && !Object.keys(view.teams).length) continue
      const id = nextPersonId(s)
      if (!id) continue
      const stamp = at.now.toISOString()
      p = {
        id,
        ...splitName(user.name),
        contactEmail: user.email,
        phone: null,
        telegramUsername: user.telegramUsername,
        notes: null,
        accountSub: user.sub,
        linkedAt: stamp,
        linkedBy: "auth",
        linkMethod: "auth",
        createdBy: "auth",
        createdAt: stamp,
        updatedBy: "auth",
        updatedAt: stamp,
      }
      s.persons[p.id] = p
      bySub.set(user.sub, p)
      log(u, p.id, "system", "Created from a role held in PoliNetwork Auth", at.now)
    }
    reconcile(u, p, directory.roles, user.roles, at, user.since)
  }
  for (const p of bySub.values()) if (!listed.has(p.accountSub as string)) reconcile(u, p, directory.roles, [], at)
}
