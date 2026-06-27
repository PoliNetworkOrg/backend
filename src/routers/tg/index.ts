import { createTRPCRouter } from "@/trpc"
import auditLog from "./audit-log"
import grants from "./grants"
import groups from "./groups"
import link from "./link"
import messages from "./messages"
import permissions from "./permissions"
import users from "./users"
import warnings from "./warnings"

export const tgRouter = createTRPCRouter({
  groups,
  permissions,
  link,
  messages,
  auditLog,
  users,
  grants,
  warnings
})
