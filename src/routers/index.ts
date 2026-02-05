import { createTRPCRouter } from "@/trpc"
import { azureRouter } from "./azure"
import { testRouter } from "./test"
import { tgRouter } from "./tg"

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  test: testRouter,
  tg: tgRouter,
  azure: azureRouter,
})

// export type definition of API
export type AppRouter = typeof appRouter
