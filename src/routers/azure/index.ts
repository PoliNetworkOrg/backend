import { createTRPCRouter } from "@/trpc"
import groups from "./groups"
import members from "./members"

export const azureRouter = createTRPCRouter({
  members,
  groups,
})
