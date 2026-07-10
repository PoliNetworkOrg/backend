import { createTRPCRouter } from "@/trpc"
import associations from "./associations"
import faqs from "./faqs"
import guides_matricole from "./guides_matricole"
import projects from "./projects"

export const webRouter = createTRPCRouter({ associations, faqs, projects, guides_matricole })
