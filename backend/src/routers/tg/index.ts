import { createTRPCRouter } from "@/trpc"
import auditLog from "./audit-log"
import groups from "./groups"
import link from "./link"
import messages from "./messages"
import permissions from "./permissions"

export const tgRouter = createTRPCRouter({
  groups,
  permissions,
  link,
  messages,
  auditLog,
})
