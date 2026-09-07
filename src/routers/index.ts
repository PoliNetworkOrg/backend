import { emailRouter } from "@/routers/email"
import { createTRPCRouter } from "@/trpc"
import { authRouter } from "./auth"
import { azureRouter } from "./azure"
import { groupsRouter } from "./groups"
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
  groups: groupsRouter,
  test: testRouter,
  tg: tgRouter,
  wa: waRouter,
  web: webRouter,
  email: emailRouter,
})

// export type definition of API
export type AppRouter = typeof appRouter
