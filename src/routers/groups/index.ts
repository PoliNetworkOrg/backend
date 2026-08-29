import { createTRPCRouter } from "@/trpc"
import labels from "./labels"

export const groupsRouter = createTRPCRouter({
  labels,
})
