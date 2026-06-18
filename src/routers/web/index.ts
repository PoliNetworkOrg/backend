import { createTRPCRouter } from "@/trpc"
import associations from "./associations"
import faqs from "./faqs"
import projects from "./projects"

export const webRouter = createTRPCRouter({ associations, faqs, projects })
