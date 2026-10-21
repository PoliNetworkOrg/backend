import { createTRPCRouter } from "@/trpc"
import { azureRouter } from "./azure"
import { esignRouter } from "./esign"
import { groupsRouter } from "./groups"
import { meRouter } from "./me"
import { tgRouter } from "./tg"
import { waRouter } from "./wa"
import { webRouter } from "./web"

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  azure: azureRouter,
  esign: esignRouter,
  groups: groupsRouter,
  me: meRouter,
  tg: tgRouter,
  wa: waRouter,
  web: webRouter,
})

// export type definition of API
export type AppRouter = typeof appRouter
