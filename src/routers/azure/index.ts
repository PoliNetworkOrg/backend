import { createTRPCRouter } from "@/trpc"
import members from "./members"

export const azureRouter = createTRPCRouter({
  members,
})
