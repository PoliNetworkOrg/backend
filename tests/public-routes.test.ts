import { createHmac } from "node:crypto"
import { readFileSync } from "node:fs"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import type { DeliveryLog } from "@/public/github-webhook"
import { createPublicRouter, PUBLIC_INGRESS_HEADER, PUBLIC_PREFIX } from "@/public/router"
import { buildPublicRoutes } from "@/public/routes"

const SECRET = "webhook-secret"

function setup(options: { handle?: (event: string, payload: unknown) => Promise<void>; now?: () => number } = {}) {
  const seen = new Set<string>()
  const deliveries: DeliveryLog = {
    claim: async (id) => {
      if (seen.has(id)) return false
      seen.add(id)
      return true
    },
    forget: async (id) => {
      seen.delete(id)
    },
  }
  const events: string[] = []
  const router = createPublicRouter(
    buildPublicRoutes({
      githubWebhookSecret: SECRET,
      deliveries,
      onGitHubEvent: options.handle ?? (async (event) => void events.push(event)),
    }),
    { now: options.now }
  )
  // Every other backend route, as far as the guard knows.
  const app = new Hono().use("*", router.guard).all("*", (c) => c.text("internal route", 200))
  return { app, router, events, seen }
}

let n = 0
function delivery(body: object, opts: { secret?: string; id?: string; event?: string; ip?: string } = {}) {
  const raw = JSON.stringify(body)
  const signature = `sha256=${createHmac("sha256", opts.secret ?? SECRET)
    .update(raw)
    .digest("hex")}`
  return {
    method: "POST",
    body: raw,
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-delivery": opts.id ?? `72d3162e-cc78-11e3-81ab-4c9367dc${String(++n).padStart(4, "0")}`,
      "x-github-event": opts.event ?? "pull_request",
      "cf-connecting-ip": opts.ip ?? "203.0.113.1",
    },
  }
}

describe("public routes", () => {
  it("are exactly the declared ones, all under /public, and checked before every other route", () => {
    // Adding a public route means adding it here, on purpose.
    expect(setup().router.routes).toEqual(["POST /public/webhooks/github"])
    expect(PUBLIC_PREFIX).toBe("/public")
    const server = readFileSync(new URL("../src/server.ts", import.meta.url), "utf8")
    const guard = server.indexOf('app.use("*", publicRoutes.guard)')
    const firstRoute = server.search(/app\.(use|get|post|all|route)\((?!"\*", publicRoutes\.guard)/)
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(firstRoute)
  })

  it("refuses paths that leave or sneak into the prefix, or aren't plain", async () => {
    const { app, events } = setup()
    const body = delivery({ pull_request: { number: 1 } })
    const fromIngress = { ...body, headers: { ...body.headers, [PUBLIC_INGRESS_HEADER]: "public" } }
    // Bun (like URL) resolves dot segments before the app runs: through the public ingress only declared routes answer.
    for (const path of [
      "/public/../api/trpc/regulations.me.get",
      "/public/%2e%2e/api/trpc",
      "/public/webhooks/../../api",
      "/api/trpc/regulations.me.get",
      "/",
    ]) {
      const res = await app.request(path, fromIngress)
      expect([path, res.status]).toEqual([path, 404])
    }
    // Paths that keep touching the prefix are refused even without the ingress header.
    for (const path of [
      "/public/webhooks/github/",
      "/public/webhooks%2Fgithub",
      "/public/webhooks/github.json",
      "/PUBLIC/webhooks/github",
      "/public",
      "/public/webhooks/gitlab",
      "/api/../public/webhooks/github/x",
    ]) {
      const res = await app.request(path, body)
      expect([path, res.status]).toEqual([path, 404])
    }
    expect((await app.request("/public/webhooks/github", { method: "GET" })).status).toBe(404)
    // Inside the cluster, other routes are untouched.
    expect(await (await app.request("/api/trpc/x")).text()).toBe("internal route")
    expect(events).toEqual([])
    // Through the ingress, the declared route works.
    expect((await app.request("/public/webhooks/github", fromIngress)).status).toBe(202)
  })

  it("accepts a signed GitHub delivery once, and ignores a replay", async () => {
    const { app, events } = setup()
    const res = await app.request(
      "/public/webhooks/github",
      delivery({ pull_request: { number: 7 } }, { id: "abcd-1234-replay" })
    )
    expect(res.status).toBe(202)
    const replay = await app.request(
      "/public/webhooks/github",
      delivery({ pull_request: { number: 7 } }, { id: "abcd-1234-replay" })
    )
    expect(replay.status).toBe(200)
    expect(await replay.json()).toEqual({ duplicate: true })
    expect(events).toEqual(["pull_request"])
  })

  it("refuses a wrong or missing signature, and a missing delivery id", async () => {
    const { app, events } = setup()
    expect((await app.request("/public/webhooks/github", delivery({ a: 1 }, { secret: "wrong" }))).status).toBe(401)
    const unsigned = delivery({ a: 1 })
    delete (unsigned.headers as Record<string, string>)["x-hub-signature-256"]
    expect((await app.request("/public/webhooks/github", unsigned)).status).toBe(401)
    const truncated = delivery({ a: 1 })
    truncated.headers["x-hub-signature-256"] = truncated.headers["x-hub-signature-256"].slice(0, 20)
    expect((await app.request("/public/webhooks/github", truncated)).status).toBe(401)
    const noId = delivery({ a: 1 }, { id: "" })
    expect((await app.request("/public/webhooks/github", noId)).status).toBe(400)
    expect(events).toEqual([])
  })

  it("lets GitHub redeliver a delivery whose handling failed", async () => {
    let fail = true
    const { app, seen } = setup({
      handle: async () => {
        if (fail) throw new Error("db down")
      },
    })
    const first = await app.request("/public/webhooks/github", delivery({ a: 1 }, { id: "retry-0000-0001" }))
    expect(first.status).toBe(500)
    expect(seen.has("retry-0000-0001")).toBe(false)
    fail = false
    expect((await app.request("/public/webhooks/github", delivery({ a: 1 }, { id: "retry-0000-0001" }))).status).toBe(
      202
    )
  })

  it("limits the body size and the request rate", async () => {
    const { app } = setup()
    const big = delivery({ padding: "x".repeat(1024 * 1024) })
    expect((await app.request("/public/webhooks/github", big)).status).toBe(413)
    let clock = 0
    const limited = setup({ now: () => clock })
    const statuses: number[] = []
    for (let i = 0; i < 61; i++)
      statuses.push((await limited.app.request("/public/webhooks/github", delivery({ i }))).status)
    expect(statuses.slice(0, 60).every((s) => s === 202)).toBe(true)
    const blocked = await limited.app.request("/public/webhooks/github", delivery({ i: 61 }))
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get("retry-after")).toBe("60")
    // Another client still gets through, until the total limit.
    expect(
      (await limited.app.request("/public/webhooks/github", delivery({ x: 1 }, { ip: "198.51.100.9" }))).status
    ).toBe(202)
    clock += 60_000
    expect((await limited.app.request("/public/webhooks/github", delivery({ y: 1 }))).status).toBe(202)
  })

  it("answers 404 without a webhook secret, as if the route didn't exist", async () => {
    const router = createPublicRouter(
      buildPublicRoutes({
        githubWebhookSecret: undefined,
        deliveries: { claim: async () => true, forget: async () => {} },
        onGitHubEvent: async () => {},
      })
    )
    const app = new Hono().use("*", router.guard)
    expect((await app.request("/public/webhooks/github", delivery({ a: 1 }))).status).toBe(404)
  })
})
