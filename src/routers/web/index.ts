import { createTRPCRouter } from "@/trpc"
import { reports } from "../web/reports"
import acknowledgements from "./acknowledgements"
import associations from "./associations"
import documents from "./documents"
import faqs from "./faqs"
import freshman from "./freshman"
import guides_matricole from "./guides_matricole"
import projects from "./projects"

export const webRouter = createTRPCRouter({
  acknowledgements,
  associations,
  documents,
  faqs,
  freshman,
  projects,
  guides_matricole,
  reports,
})
