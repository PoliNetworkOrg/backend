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

export const USER_ROLE = {
  ADMIN: "admin",
  HR: "hr",
  PRESIDENT: "president",
  DIRETTIVO: "direttivo",
  CREATOR: "creator",
  OWNER: "owner",
} as const
