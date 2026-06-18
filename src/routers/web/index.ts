import { createTRPCRouter } from "@/trpc"
import faqs from "./faqs"
import projects from "./projects"

export const webRouter = createTRPCRouter({ faqs, projects })
