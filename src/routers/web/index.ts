import { createTRPCRouter } from "@/trpc"
import projects from "./projects"

export const webRouter = createTRPCRouter({ projects })
