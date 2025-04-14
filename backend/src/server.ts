import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { logger as loggerMiddlware } from "hono/logger";
import { appRouter } from "./routers";
import { AUTH_PATH, TRPC_PATH, TRUSTED_ORIGINS } from "./constants";
import { DB, SCHEMA } from "./db";
import { env } from "./env";
import { logger } from "./logger";
import { trpcServer } from "@hono/trpc-server";
import { auth } from "./auth";

const app = new Hono();
const isDev = env.NODE_ENV === "development";
logger.debug(`isDev ${isDev ? "YES" : "NO"}`);
if (isDev) {
  app.use(loggerMiddlware((msg, ...str) => logger.debug(str.length ? {props: str} : undefined, msg)));
}

app.use(
  `${TRPC_PATH}/*`,
  trpcServer({
    router: appRouter,
    endpoint: TRPC_PATH,
    createContext: (_opts, c) => ({ userId: c.req.header("userId") }),
  }),
);

app.use(
	`${AUTH_PATH}/*`,
	cors({
		origin: TRUSTED_ORIGINS,
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["POST", "GET", "OPTIONS"],
		exposeHeaders: ["Content-Length"],
		maxAge: 600,
		credentials: true,
	}),
);

app.on(["GET", "POST"], `${AUTH_PATH}/*`, (c) => auth.handler(c.req.raw))

app.get("/", (c) => c.text("hi"));

(async () => {
  try {
    serve({ port: env.PORT, hostname: "0.0.0.0", fetch: app.fetch }, (addr) =>
      logger.info(`Server running on ${addr.address}:${addr.port}`),
    );
    const q1 = await DB.select().from(SCHEMA.TG.test);
    const q2 = await DB.select().from(SCHEMA.WEB.test);
    logger.info({ q1, q2 }, "db working:");
  } catch (err) {
    logger.error(err);
    process.exit(1);
  }
})();
