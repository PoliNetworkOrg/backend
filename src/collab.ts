/**
 * Entrypoint of the regulations collab service (Hocuspocus): `bun run collab.js` in the backend image, its own pod.
 * It shares the backend's database (the backend runs the migrations) and needs no IdP configuration: connections
 * authenticate with tickets the backend issues.
 */
import { createEnv } from "@t3-oss/env-core"
import { SQL } from "bun"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/bun-sql"
import pino from "pino"
import { z } from "zod"
import { schema } from "./db/schema"
import { blobs } from "./db/schema/regulations"
import { startCollab } from "./regulations/collab/server"
import { createWorkerClient } from "./regulations/compile/client"
import type { AssetBundle } from "./regulations/compile/protocol"
import { type CompileEvent, createCompiler } from "./regulations/compile/service"
import { createCompileStore } from "./regulations/compile/store-pg"

const env = createEnv({
  server: {
    DB_HOST: z.string().min(1),
    DB_PORT: z.coerce.number().min(1).max(65535).default(5432),
    DB_USER: z.string().min(1),
    DB_PASS: z.string().min(1),
    DB_NAME: z.string().min(3).default("polinetwork_backend"),
    COLLAB_PORT: z.coerce.number().min(0).max(65535).default(4100),
    COLLAB_INTERNAL_PORT: z.coerce.number().min(0).max(65535).default(4101),
    REGULATIONS_INTERNAL_SECRET: z.string().min(32),
    REGULATIONS_WORKER_URL: z.url().optional(),
    REGULATIONS_WORKER_SECRET: z.string().min(1).optional(),
    REGULATIONS_COMPILE_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(3),
    COLLAB_SNAPSHOT_MINUTES: z.coerce.number().min(1).default(10),
    LOG_LEVEL: z.string().default("info"),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
})

const logger = pino({ level: env.LOG_LEVEL.toLowerCase() })
const client = new SQL({
  hostname: env.DB_HOST,
  port: env.DB_PORT,
  username: env.DB_USER,
  password: env.DB_PASS,
  database: env.DB_NAME,
})
const db = drizzle({ client, schema })

let onCompileEvent: (event: CompileEvent) => void = () => {}
const compiler = env.REGULATIONS_WORKER_URL
  ? createCompiler({
      store: createCompileStore(db),
      concurrency: env.REGULATIONS_COMPILE_CONCURRENCY,
      worker: createWorkerClient({
        url: env.REGULATIONS_WORKER_URL,
        secret: env.REGULATIONS_WORKER_SECRET,
        async loadAssets(hash) {
          const [blob] = await db.select().from(blobs).where(eq(blobs.hash, hash))
          if (!blob) throw new Error(`asset bundle ${hash} not found`)
          return JSON.parse(Buffer.from(blob.content).toString("utf8")) as AssetBundle
        },
      }),
      onEvent: (event) => onCompileEvent(event),
      onError: (err, job) => logger.error({ err, draftId: job.draftId }, "[COLLAB] compile failed"),
    })
  : undefined
if (!compiler) logger.warn("[COLLAB] REGULATIONS_WORKER_URL is not set: drafts are not compiled")

const collab = await startCollab({
  db,
  logger,
  port: env.COLLAB_PORT,
  internalPort: env.COLLAB_INTERNAL_PORT,
  internalSecret: env.REGULATIONS_INTERNAL_SECRET,
  compiler,
  snapshotEveryMs: env.COLLAB_SNAPSHOT_MINUTES * 60_000,
})
onCompileEvent = collab.onCompileEvent

const shutdown = async () => {
  logger.info("[COLLAB] shutting down")
  await collab.stop()
  await client.close()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
