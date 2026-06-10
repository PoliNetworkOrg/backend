import { createTRPCRouter } from "@/trpc"
import associations from "./associations"

export const webRouter = createTRPCRouter({ associations })
