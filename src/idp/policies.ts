import type { Policy } from "@/trpc"

/** Backend scopes (RFC v3 §6.2). */
export const SCOPE = {
  admin: "backend:admin",
  publicRead: "backend:public:read",
  tgRead: "backend:tg:read",
  tgIngest: "backend:tg:ingest",
  tgGroupsSync: "backend:tg:groups:sync",
  tgAudit: "backend:tg:audit",
  tgEvents: "backend:tg:events",
} as const

/** Dashboard users holding `permission`. */
export function dashboard(permission: string): Policy {
  return { user: { scope: SCOPE.admin, permission } }
}

/** The bot's lookups, or dashboard users holding `permission`. */
export function botReadOrDashboard(permission: string): Policy {
  return { service: { scope: SCOPE.tgRead }, ...dashboard(permission) }
}

/** Public website data, also readable in the dashboard. */
export const publicData: Policy = { service: { scope: SCOPE.publicRead }, ...dashboard("admin:access") }
