import { serve } from "@hono/node-server"
import { trpcServer } from "@hono/trpc-server"
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger as loggerMiddlware } from "hono/logger"
import z from "zod"
import { auth } from "./auth"
import { AUTH_PATH, TRPC_PATH, WS_PATH } from "./constants"
import { cron } from "./cron"
import { DB, SCHEMA } from "./db"
import { sendWelcomeEmail } from "./emails/mailer"
import { env } from "./env"
import { logger } from "./logger"
import { appRouter } from "./routers"
import { WebSocketServer } from "./websocket"

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

// enable if need testing
app.post(
  "/test/welcome-email",
  zValidator(
    "json",
    z.object({ toAddress: z.email(), firstName: z.string(), lastName: z.string(), assocNumber: z.number() })
  ),
  async (c) => {
    if (env.NODE_ENV === "production") return c.status(500)

    const { toAddress, firstName, lastName, assocNumber } = c.req.valid("json")
    try {
      await sendWelcomeEmail(
        toAddress,
        {
          // temporary, just for test
          email: `${firstName.split(" ").join("").toLowerCase()}.${lastName.split(" ").join("").toLowerCase()}@polinetwork.org`,
          password: "R@123123123123as",
        },
        { firstName, assocNumber }
      )
      return c.json({ sent: true, err: null })
    } catch (err) {
      c.status(500)
      logger.error({ err }, "ERROR in /test-email route")
      return c.json({ sent: false, err })
    }
  }
)

const server = serve({ port: env.PORT, hostname: "0.0.0.0", fetch: app.fetch }, (addr) =>
  logger.info(`Server running on ${addr.address}:${addr.port}`)
)

export const WSS = new WebSocketServer(server, WS_PATH)

// Graceful shutdown for hot-reloading
let isShuttingDown = false
const shutdown = async () => {
  if (isShuttingDown) return

  isShuttingDown = true
  logger.info("[SERVER] Recieved shutdown signal, shutting down...")
  server.close((err) => {
    if (err) {
      logger.error({ err }, "[SERVER] Shutdown error")
      process.exit(1)
    }

    logger.info("[SERVER] Shutdown completed")
    process.exit(0)
  })
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)

await Promise.race([
  DB.select().from(SCHEMA.TG.test),
  new Promise((_, rej) => {
    setTimeout(rej, 5000)
  }),
])
  .then((res) => logger.info({ res }, "DB working. Select * from tg_test:"))
  .catch(() => logger.error("DB not working!"))

cron()
