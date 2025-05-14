import { createTRPCRouter } from "@/trpc";
import groups from "./groups";
import permissions from "./permissions";
import link from "./link";
import messages from "./messages";
import auditLog from "./audit-log";

export const tgRouter = createTRPCRouter({
  groups,
  permissions,
  link,
  messages,
  auditLog,
});
