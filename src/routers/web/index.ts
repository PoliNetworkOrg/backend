import { createTRPCRouter } from "@/trpc"
import associations from "./associations"
import projects from "./projects"

export const webRouter = createTRPCRouter({ associations, projects })
