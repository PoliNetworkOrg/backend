import { createTRPCRouter } from "@/trpc"
import access from "./access"
import auditLog from "./audit-log"
import grants from "./grants"
import groups from "./groups"
import messages from "./messages"
import users from "./users"
import warnings from "./warnings"

export const tgRouter = createTRPCRouter({
  access,
  groups,
  messages,
  auditLog,
  users,
  grants,
  warnings,
})
