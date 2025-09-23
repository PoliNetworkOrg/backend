import { initTRPC, TRPCError } from "@trpc/server";
import { z, ZodError } from "zod";
import { logger } from "./logger";
import superjson from "superjson";

type Context = {
  userId?: string;
};

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError:
          error.cause instanceof ZodError ? z.treeifyError(error.cause) : null,
      },
    };
  },
});

export const createTRPCRouter = t.router;

/**
 *  iddleware for timing procedure execution and adding an artificial delay in development.
 *
 *  ou can remove this if you don't like it, but it can help catch unwanted waterfalls by simulating
 *  etwork latency that would occur in production but not in local development.
 */ const timingMiddleware = t.middleware(async ({ next, path }) => {
  const start = Date.now();

  if (t._config.isDev) {
    // artificial delay in dev
    const waitMs = Math.floor(Math.random() * 100) + 100;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const result = await next();

  const end = Date.now();
  logger.debug(`[TRPC] ${path} took ${end - start}ms to execute`);

  return result;
});

/**
 *  ublic (unauthenticated) procedure
 *
 *  his is the base piece you use to build new queries and mutations on your tRPC API. It does not
 *  uarantee that a user querying is authorized, but you can still access user session data if they
 *  re logged in.
 */ export const publicProcedure = t.procedure.use(timingMiddleware);

const enforceUserIsAuthed = t.middleware(async ({ ctx, next }) => {
  if (!ctx.userId || ctx.userId === "anonymous") {
    throw new TRPCError({
      code: "UNAUTHORIZED",
    });
  }

  return next({
    ctx: {
      userId: ctx.userId,
    },
  });
});

export const protectedProcedure = t.procedure.use(enforceUserIsAuthed);
