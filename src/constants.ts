export const TRPC_PATH = "/api/trpc"
export const AUTH_PATH = "/api/auth"
export const WS_PATH = "/ws"

export const TRUSTED_ORIGINS = [
  "http://localhost:3001",
  "http://localhost:3002",
  "http://localhost:3003",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
]

export const MESSAGES_RETENTION_DAYS = 7
/** Expired sessions are deleted this many days after they expire (privacy policy, data retention). */
export const SESSIONS_RETENTION_DAYS = 30
/** How long kicks and revocations stay in the moderation audit log; see `endedMeasures`. */
export const ENDED_MODERATION_RETENTION_DAYS = 1

export const USER_ROLE = {
  ADMIN: "admin",
  HR: "hr",
  PRESIDENT: "president",
  DIRETTIVO: "direttivo",
  CREATOR: "creator",
  OWNER: "owner",
  WEB: "web",
} as const
