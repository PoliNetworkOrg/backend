import { createTRPCRouter } from "@/trpc"
import groupLabels from "../groups/labels"
import grants from "./grants"
import groups from "./groups"
import link from "./link"
import messages from "./messages"
import permissions from "./permissions"
import users from "./users"
import auditLog from "./audit-log"

export const tgRouter = createTRPCRouter({
  groups,
  groupLabels,
  permissions,
  link,
  messages,
  auditLog,
  users,
  grants,
})
