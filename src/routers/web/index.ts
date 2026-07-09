import { createTRPCRouter } from "@/trpc"
import associations from "./associations"
import faqs from "./faqs"
import matricole from "./matricole"
import projects from "./projects"

export const webRouter = createTRPCRouter({ associations, faqs, projects, matricole })
