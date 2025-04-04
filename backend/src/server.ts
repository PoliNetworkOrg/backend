import {
  fastifyTRPCPlugin,
  FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { appRouter, type AppRouter } from "./routers";
import { TRPC_PATH } from "./constants";
import { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";
import { DB } from "./db";
import { createTRPCContext } from "./trpc";

const isDev = process.env.NODE_ENV === "development";
console.log("isDev", isDev ? "YES" : "NO");

const server = fastify({
  maxParamLength: 5000,
  logger: true,
}).withTypeProvider<JsonSchemaToTsProvider>();

server.register(fastifyTRPCPlugin, {
  prefix: TRPC_PATH,
  trpcOptions: {
    router: appRouter,
    createContext: createTRPCContext,
    onError({ path, error }) {
      // report to error monitoring
      console.error(`Error in tRPC handler on path '${path}':`, error);
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

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

(async () => {
  try {
    await server.listen({ port: PORT });
    const q1 = await DB.WEB.query.testTable.findMany();
    const q2 = await DB.TG.query.testTable.findMany();
    console.log("db working: ", q1, q2);
    console.log("listening on port: ", PORT);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
})();
