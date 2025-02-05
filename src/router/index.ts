import { initTRPC } from "@trpc/server";
import { z } from "zod";

export const t = initTRPC.create();
export const appRouter = t.router({
  add: t.procedure.input(z.array(z.number())).query((opts) => {
    return opts.input.reduce((a, b) => a + b, 0);
  }),
});

export type AppRouter = typeof appRouter;
