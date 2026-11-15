import { regulations, regulationsDiff, regulationsDirectory, regulationsEmanation } from "@/regulations"
import { createRegulationsRouter } from "@/regulations/router"

export const regulationsRouter = createRegulationsRouter(regulations, regulationsDirectory, {
  diff: regulationsDiff,
  emanation: regulationsEmanation,
})
