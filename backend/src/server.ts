import {
  fastifyTRPCPlugin,
  FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { appRouter, type AppRouter } from "./routers";
import { TRPC_PATH } from "./constants";
import { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import { DB, SCHEMA } from "./db";
import { createTRPCContext } from "./trpc";
import { env } from "./env";

const server = fastify({
  maxParamLength: 5000,
  logger: {
    level: env.LOG_LEVEL,
  },
}).withTypeProvider<JsonSchemaToTsProvider>();

const isDev = env.NODE_ENV === "development";
server.log.debug(`isDev ${isDev ? "YES" : "NO"}`);

server.register(fastifyTRPCPlugin, {
  prefix: TRPC_PATH,
  trpcOptions: {
    router: appRouter,
    createContext: createTRPCContext,
    onError({ path, error }) {
      // report to error monitoring
      server.log.error({error}, `Error in tRPC handler on path '${path}':`);
    },
  } satisfies FastifyTRPCPluginOptions<AppRouter>["trpcOptions"],
});

if (isDev) {
  server.addHook("preHandler", async (request) => {
    // Development-specific logging
    server.log.debug({
      path: request.url,
      method: request.method,
      body: request.body,
    });
  });
}

server.get("/", (_, res) => res.send("hi"));

const PORT = env.PORT;

(async () => {
  try {
    await server.listen({ port: PORT, host: "0.0.0.0" });
    const q1 = await DB.select().from(SCHEMA.TG.test);
    const q2 = await DB.select().from(SCHEMA.WEB.test);
    server.log.info({q1, q2}, "db working:",);
    server.log.info(`listening on port: ${PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
})();
