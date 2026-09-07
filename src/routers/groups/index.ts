import { createTRPCRouter } from "@/trpc"
import labels from "./labels"
import { search } from "./search"

export const groupsRouter = createTRPCRouter({
  labels,
  search,
})
