import { trpcServer } from "@hono/trpc-server"
import { zValidator } from "@hono/zod-validator"
import { Hono } from "hono"
import { cors } from "hono/cors"
import { logger as loggerMiddlware } from "hono/logger"
import z from "zod"
import { auth } from "./auth"
import { getMembers } from "./azure/functions"
import { AUTH_PATH, TRPC_PATH, WS_PATH } from "./constants"
import { cron } from "./cron"
import { DB, SCHEMA } from "./db"
import { sendWelcomeEmail } from "./emails/mailer"
import { env } from "./env"
import { logger } from "./logger"
import { appRouter } from "./routers"
import { WebSocketServer, engine as wssEngine } from "./websocket"

export const WSS = new WebSocketServer()
const app = new Hono()

const server = Bun.serve({
  port: env.PORT,
  ...wssEngine.handler(),
  fetch: app.fetch,
})

logger.info(`Server running on ${server.url}`)
logger.debug({ valueFromT3: env.NODE_ENV, valueFromProcess: process.env.NODE_ENV ?? "undefined" }, "NODE_ENV")

if (env.NODE_ENV === "development") {
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

app.post(
  "/test/welcome-email",
  zValidator(
    "json",
    z.object({ toAddress: z.email(), firstName: z.string(), lastName: z.string(), assocNumber: z.number() })
  ),
  async (c) => {
    if (env.NODE_ENV === "production") return c.status(500)

    const { toAddress, firstName, lastName, assocNumber } = c.req.valid("json")
    const sent = await sendWelcomeEmail(
      toAddress,
      {
        // temporary, just for test
        email: `${firstName.split(" ").join("").toLowerCase()}.${lastName.split(" ").join("").toLowerCase()}@polinetwork.org`,
        password: "R@123123123123as",
      },
      { firstName, assocNumber }
    )
    return c.json({ sent })
  }
)

app.get("/test/members", async (c) => {
  if (env.NODE_ENV === "production") return c.status(500)

  const users = await getMembers()
  return c.json({ users })
})

app.all(`${WS_PATH}/`, (c) => {
  return wssEngine.handleRequest(c.req.raw, server)
})

// Graceful shutdown for hot-reloading
let isShuttingDown = false
const shutdown = async () => {
  if (isShuttingDown) return

  isShuttingDown = true
  logger.info("[SERVER] Received shutdown signal, shutting down...")

  const err = await WSS.close()
  if (err) {
    logger.error({ err }, "[SERVER] Shutdown error on WebSocketServer")
    process.exit(1)
  }

  logger.info("[SERVER] Shutdown completed")
  process.exit(0)
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
process.on("uncaughtException", (err) => {
  logger.error({ err }, "!!! Uncaught Exception")
})

process.on("unhandledRejection", (err) => {
  logger.error({ err }, "!!! Unhandled Rejection")
})

await Promise.race([
  DB.select().from(SCHEMA.TG.test),
  new Promise((_, rej) => {
    setTimeout(rej, 5000)
  }),
])
  .then((res) => logger.info({ res }, "DB working. Select * from tg_test:"))
  .catch(() => logger.error("DB not working!"))

cron()
