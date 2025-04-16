import { createTRPCRouter } from "@/trpc";
import groups from "./groups";
import permissions from "./permissions";
import link from "./link";

export const tgRouter = createTRPCRouter({
  groups,
  permissions,
  link,
});
