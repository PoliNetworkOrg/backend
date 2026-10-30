import { type PeopleRoles, RoleChangeError, type RoleCommand, type RoleDirectory } from "@/people/roles"
import type { BoundRole } from "@/people/rules"

/** Roles bound to People in the fake Auth. `design` has none, so it can't be assigned. */
export const BOUND: BoundRole[] = [
  { key: "admin", name: "Admin", binding: "admin", permissions: ["admin:access"], bindings: ["admin"] },
  {
    key: "capo-admin",
    name: "Capo Admin",
    binding: "capo",
    permissions: ["admin:access", "people:read"],
    bindings: ["capo", "admin"],
  },
  { key: "it-member", name: "IT", binding: "team:it:member", permissions: [], bindings: ["team:it:member"] },
  {
    key: "it-lead",
    name: "IT Lead",
    binding: "team:it:lead",
    permissions: ["people:self"],
    bindings: ["team:it:lead"],
  },
  {
    key: "hr-member",
    name: "HR",
    binding: "team:hr:member",
    permissions: ["people:read"],
    bindings: ["team:hr:member"],
  },
]

/**
 * PoliNetwork Auth's People endpoints, in memory: a role per binding, commands applied at most once per ID.
 * `mode` simulates outages: `down` answers nothing, `lost` applies the command and loses the answer once.
 */
export function fakeAuth(roles: BoundRole[] = structuredClone(BOUND)) {
  const held = new Map<string, Set<string>>()
  const names = new Map<string, string>()
  const since = new Map<string, Record<string, string>>()
  const applied = new Set<string>()
  const state = {
    mode: "up" as "up" | "down" | "lost",
    refusal: null as { status: number; message: string } | null,
    /** Runs before a command is applied, e.g. to change Auth between People's read and its command. */
    before: null as ((command: RoleCommand) => void) | null,
    /** Refuses only the commands it returns a refusal for, e.g. one actor's. */
    refuse: null as ((command: RoleCommand) => { status: number; message: string } | null) | null,
    calls: [] as RoleCommand[],
    reads: 0,
  }
  const keyOf = (binding: string) => roles.find((r) => r.binding === binding)?.key
  function rolesOf(sub: string) {
    if (!held.has(sub)) held.set(sub, new Set())
    return held.get(sub) as Set<string>
  }
  function result(sub: string) {
    const keys = [...rolesOf(sub)].sort()
    return { roles, held: keys, assigned: keys }
  }
  const auth: PeopleRoles = {
    async directory(): Promise<RoleDirectory> {
      state.reads += 1
      if (state.mode === "down") throw new Error("Auth is down")
      return {
        roles,
        users: [...held]
          .filter(([, keys]) => keys.size)
          .map(([sub, keys]) => ({
            sub,
            name: names.get(sub) ?? sub,
            email: `${sub}@polinetwork.org`,
            telegramId: null,
            telegramUsername: null,
            roles: [...keys].sort(),
            assigned: [...keys].sort(),
            since: since.get(sub),
          })),
      }
    },
    async change(command) {
      state.calls.push(structuredClone(command))
      if (state.mode === "down") throw new RoleChangeError(503, "PoliNetwork Auth could not be reached")
      state.before?.(command)
      const refusal = state.refusal ?? state.refuse?.(command)
      if (refusal) throw new RoleChangeError(refusal.status, refusal.message)
      if (!applied.has(command.id)) {
        applied.add(command.id)
        const keys = rolesOf(command.sub)
        for (const change of command.changes) {
          if (change.kind !== "team") {
            const key = keyOf(change.kind)
            if (key && change.active) keys.add(key)
            else if (key) keys.delete(key)
            continue
          }
          for (const role of ["member", "lead"]) {
            const key = keyOf(`team:${change.team}:${role}`)
            if (key) keys.delete(key)
          }
          const key = change.role && keyOf(`team:${change.team}:${change.role}`)
          if (key) keys.add(key)
        }
      }
      if (state.mode === "lost") {
        state.mode = "up"
        throw new RoleChangeError(503, "PoliNetwork Auth sent an unreadable answer")
      }
      return result(command.sub)
    },
  }
  return {
    auth,
    /** The bound roles Auth answers with; tests may change them. */
    roles,
    state,
    applied,
    /** Gives a role by hand in Auth. */
    give(sub: string, key: string, name?: string, on?: string) {
      rolesOf(sub).add(key)
      if (name) names.set(sub, name)
      if (on) since.set(sub, { ...since.get(sub), [key]: on })
    },
    take(sub: string, key: string) {
      rolesOf(sub).delete(key)
    },
    held: (sub: string) => [...rolesOf(sub)].sort(),
  }
}
