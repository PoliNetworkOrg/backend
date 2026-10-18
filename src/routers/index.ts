import { createTRPCRouter } from "@/trpc"
import { authRouter } from "./auth"
import { azureRouter } from "./azure"
import { esignRouter } from "./esign"
import { groupsRouter } from "./groups"
import { meRouter } from "./me"
import { peopleRouter } from "./people"
import { testRouter } from "./test"
import { tgRouter } from "./tg"
import { waRouter } from "./wa"
import { webRouter } from "./web"

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  auth: authRouter,
  azure: azureRouter,
  esign: esignRouter,
  groups: groupsRouter,
  me: meRouter,
  people: peopleRouter,
  test: testRouter,
  tg: tgRouter,
  wa: waRouter,
  web: webRouter,
})

// export type definition of API
export type AppRouter = typeof appRouter
