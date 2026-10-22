import { createTRPCRouter } from "@/trpc"
import { reports } from "../web/reports"
import associations from "./associations"
import faqs from "./faqs"
import freshman from "./freshman"
import guides_matricole from "./guides_matricole"
import projects from "./projects"

export const webRouter = createTRPCRouter({ associations, faqs, freshman, projects, guides_matricole, reports })
