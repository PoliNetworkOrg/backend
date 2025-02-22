import { createTRPCRouter } from "@/trpc";
import { testRouter } from "./test";
import { tgRouter } from "./tg";

/**
 * This is the primary router for your server.
 *
 * All routers added in /api/routers should be manually added here.
 */
export const appRouter = createTRPCRouter({
  test: testRouter,
  tg: tgRouter,
});

// export type definition of API
export type AppRouter = typeof appRouter;
