import { regulations, regulationsDirectory } from "@/regulations"
import { createRegulationsRouter } from "@/regulations/router"

export const regulationsRouter = createRegulationsRouter(regulations, regulationsDirectory)
