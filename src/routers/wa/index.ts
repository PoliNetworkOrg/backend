import { createTRPCRouter } from "@/trpc"
import groups from "./groups"

export const waRouter = createTRPCRouter({
  groups,
})
