import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { connect } from "node:net"
import { SQL } from "bun"
import { drizzle } from "drizzle-orm/bun-sql"
import { migrate } from "drizzle-orm/bun-sql/migrator"
import { Hono } from "hono"
import { schema } from "@/db/schema"
import { webhookDeliveries } from "@/db/schema/common/webhook-deliveries"
import { pgDeliveryLog } from "@/public/github-webhook"
import { createPublicRouter } from "@/public/router"
import { buildPublicRoutes } from "@/public/routes"

/** /public/webhooks/github on a real Bun server and Postgres, with raw request targets. */
const connection = {
  hostname: "127.0.0.1",
  port: Number(process.env.SEED_TEST_DB_PORT),
  username: "seed_test",
  password: "seed_test",
}
const admin = new SQL({ ...connection, database: "postgres" })
const databaseName = `public_webhook_${process.pid}`
await admin.unsafe(`CREATE DATABASE ${databaseName}`)
const client = new SQL({ ...connection, database: databaseName })
const db = drizzle({ client, schema })
const checked: string[] = []
const events: [string, unknown][] = []
const router = createPublicRouter(
  buildPublicRoutes({
    githubWebhookSecret: "s3cret",
    deliveries: pgDeliveryLog(db),
    onGitHubEvent: async (e, p) => void events.push([e, p]),
  })
)
const app = new Hono().use("*", router.guard).all("*", (c) => c.text(`internal ${new URL(c.req.url).pathname}`))
const server = Bun.serve({ port: 0, fetch: app.fetch })

function raw(target: string, headers: Record<string, string>, body = ""): Promise<string> {
  return new Promise((resolve) => {
    const sock = connect(server.port as number, "127.0.0.1", () => {
      const head = Object.entries({
        Host: "api.polinetwork.org",
        Connection: "close",
        "Content-Length": String(Buffer.byteLength(body)),
        ...headers,
      })
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n")
      sock.write(`POST ${target} HTTP/1.1\r\n${head}\r\n\r\n${body}`)
    })
    let data = ""
    sock.on("data", (c) => {
      data += c
    })
    sock.on("end", () => resolve(data.split("\r\n")[0]))
  })
}

try {
  await migrate(db, { migrationsFolder: "./drizzle" })
  const body = JSON.stringify({ action: "closed", pull_request: { number: 7, merged: true } })
  const headers = {
    "Content-Type": "application/json",
    "X-Hub-Signature-256": `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`,
    "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    "X-GitHub-Event": "pull_request",
    "X-PoliNetwork-Ingress": "public",
  }
  assert.equal(await raw("/public/webhooks/github", headers, body), "HTTP/1.1 202 Accepted")
  assert.equal(await raw("/public/webhooks/github", headers, body), "HTTP/1.1 200 OK")
  assert.equal(events.length, 1)
  assert.equal((await db.select().from(webhookDeliveries)).length, 1)
  checked.push("a signed delivery is handled once and recorded in Postgres; the replay is acknowledged and ignored")

  for (const target of [
    "/public/../api/trpc/regulations.me.get",
    "/public/%2e%2e/api/trpc",
    "/public/webhooks/../../api",
  ])
    assert.equal(await raw(target, headers, body), "HTTP/1.1 404 Not Found", target)
  assert.equal(
    await raw("/public/webhooks/github", { ...headers, "X-Hub-Signature-256": "sha256=00" }, body),
    "HTTP/1.1 401 Unauthorized"
  )
  checked.push("through the public ingress, raw dot-segment escapes and bad signatures are refused")
  console.log(JSON.stringify({ checked }))
} finally {
  server.stop(true)
  await client.close()
  await admin.unsafe(`DROP DATABASE ${databaseName} WITH (FORCE)`)
  await admin.close()
}
