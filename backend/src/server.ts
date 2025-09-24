import { serve } from "@hono/node-server"
import { trpcServer } from "@hono/trpc-server"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger as loggerMiddlware } from "hono/logger"
import { auth } from "./auth"
import { AUTH_PATH, TRPC_PATH, WS_PATH } from "./constants"
import { cron } from "./cron"
import { DB, SCHEMA } from "./db"
import { env } from "./env"
import { logger } from "./logger"
import { appRouter } from "./routers"
import { WebsocketServer as WebSocketServer } from "./websocket"

const app = new Hono()
const isDev = env.NODE_ENV === "development"
logger.debug(`isDev ${isDev ? "YES" : "NO"}`)
if (isDev) {
  app.use(loggerMiddlware((msg, ...str) => logger.debug(str.length ? { props: str } : undefined, msg)))
}

app.use(
  `${TRPC_PATH}/*`,
  trpcServer({
    router: appRouter,
    endpoint: TRPC_PATH,
    createContext: (_opts, c) => ({ userId: c.req.header("userId") }),
  })
)

app.use(
  `${AUTH_PATH}/*`,
  cors({
    origin: env.TRUSTED_ORIGINS,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  })
)

app.on(["GET", "POST"], `${AUTH_PATH}/*`, (c) => auth.handler(c.req.raw))

app.get("/", (c) => c.text("hi"))
app.get("/ban", async (c) => {
  const ok = await WSS.ban(992285066, -1002404957288)
  return c.text(`OK: ${ok}`)
})

const server = serve({ port: env.PORT, hostname: "0.0.0.0", fetch: app.fetch }, (addr) =>
  logger.info(`Server running on ${addr.address}:${addr.port}`)
)

export const WSS = new WebSocketServer(server, WS_PATH)

await Promise.race([
  DB.select().from(SCHEMA.TG.test),
  new Promise((_, rej) => {
    setTimeout(rej, 5000)
  }),
])
  .then((res) => logger.info({ res }, "DB working. Select * from tg_test:"))
  .catch(() => logger.error("DB not working!"))

cron()
