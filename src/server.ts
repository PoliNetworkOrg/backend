import {
  fastifyTRPCPlugin,
  FastifyTRPCPluginOptions,
} from "@trpc/server/adapters/fastify";
import fastify from "fastify";
import { createContext } from "./context";
import { appRouter, type AppRouter } from "./router";
import { TRPC_PATH } from "./constants";
import "dotenv/config";
import { DB, SCHEMA } from "./db";
import { JsonSchemaToTsProvider } from "@fastify/type-provider-json-schema-to-ts";

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
    createContext,
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

server.get(
  "/dbtest/:dbName",
  {
    schema: {
      params: {
        type: "object",
        properties: {
          dbName: { type: "string" },
        },
      },
    },
  },
  async (req, res) => {
    const { dbName } = req.params;

    if (dbName === "tg") {
      const q = await DB.TG.select().from(SCHEMA.TG.testTable);
      return res.send(q.map(e => e.text).join("\n"));
    } else if (dbName === "web") {
      const q = await DB.WEB.select().from(SCHEMA.WEB.testTable);
      return res.send(q.map(e => e.text).join("\n"));
    } else return res.status(404).send("db not found");
  },
);

server.post(
  "/dbtest/:dbName",
  {
    schema: {
      body: {
        type: "object",
        properties: {
          text: { type: "string" },
        },
        required: ["text"],
      },
      params: {
        type: "object",
        properties: {
          dbName: { type: "string" },
        },
      },
    },
  },
  async (req, res) => {
    const { dbName } = req.params;

    const text = req.body.text;
    if (!text) return res.status(400).send("text not specified");

    if (dbName === "tg") {
      await DB.TG.insert(SCHEMA.TG.testTable).values({ text });
      return res.send("value inserted inside tg db");
    } else if (dbName === "web") {
      await DB.WEB.insert(SCHEMA.WEB.testTable).values({ text });
      return res.send("value inserted inside web db");
    } else return res.status(404).send("db not found");
  },
);

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

(async () => {
  try {
    await server.listen({ port: PORT });
    console.log("listening on port: ", PORT);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
})();
