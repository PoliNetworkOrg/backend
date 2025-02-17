import { createTRPCRouter } from "@/trpc";
import groups from "./groups";

export const tgRouter = createTRPCRouter({
  groups,
});
