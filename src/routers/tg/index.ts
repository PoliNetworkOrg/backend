import { createTRPCRouter } from "@/trpc"
import groupLabels from "../groups/labels"
import access from "./access"
import auditLog from "./audit-log"
import grants from "./grants"
import groups from "./groups"
import link from "./link"
import messages from "./messages"
import permissions from "./permissions"
import users from "./users"

export const tgRouter = createTRPCRouter({
  access,
  groups,
  groupLabels,
  permissions,
  link,
  messages,
  auditLog,
  users,
  grants,
})
