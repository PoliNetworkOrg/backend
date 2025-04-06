import { createTRPCRouter } from "@/trpc";
import groups from "./groups";
import permissions from "./permissions";

export const tgRouter = createTRPCRouter({
  groups,
  permissions
});
