import type { MiddlewareHandler } from "hono"

/**
 * The backend's only public surface (regulations spec, "Public backend routes"). The backend is in-cluster only; the
 * ingress (polinetwork-cd `apps/backend/public-route.yaml`) exposes `/public/...` and nothing else. Every route under
 * the prefix is declared here, with its own authentication, body size limit and rate limits, and
 * `tests/public-routes.test.ts` lists them, so a new public route can't appear by accident.
 */
export const PUBLIC_PREFIX = "/public"

/**
 * Set by the public ingress (polinetwork-cd `public-route.yaml`), overwriting any value the client sent. Bun resolves
 * `..` and `%2e%2e` before the app sees the path, so `/public/../api/trpc` reaches the app as `/api/trpc`: a request
 * that came through the public ingress may only reach a declared public route, whatever its path became.
 */
export const PUBLIC_INGRESS_HEADER = "x-polinetwork-ingress"

/** Plain segments only, like the ingress: no dots, no encoded characters, no trailing slash. */
const PUBLIC_PATH = /^\/public(\/[A-Za-z0-9_-]+)+$/

export type PublicRoute = {
  method: "POST"
  /** Under PUBLIC_PREFIX, matching PUBLIC_PATH. */
  path: string
  /** Bytes. Larger bodies get 413 before the handler reads them. */
  maxBodyBytes: number
  /** Requests per minute, for everyone together and per client address. */
  rateLimit: { perMinute: number; perClientPerMinute: number }
  /** Does its own authentication. Receives the body already read (within the limit). */
  handler: (input: { headers: Headers; body: Uint8Array }) => Promise<Response>
}

/** Fixed one-minute windows, in memory: one backend replica. */
function createRateLimiter(now: () => number) {
  const windows = new Map<string, { start: number; count: number }>()
  return (key: string, limit: number): number | null => {
    const at = now()
    const window = windows.get(key)
    if (!window || at - window.start >= 60_000) {
      windows.set(key, { start: at, count: 1 })
      if (windows.size > 10_000) for (const [k, w] of windows) if (at - w.start >= 60_000) windows.delete(k)
      return null
    }
    window.count++
    return window.count > limit ? Math.ceil((window.start + 60_000 - at) / 1000) : null
  }
}

/** The client's address as cloudflared and Traefik pass it on. */
function clientOf(headers: Headers): string {
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    headers.get("x-real-ip") ??
    "unknown"
  )
}

async function readLimited(req: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "NaN")
  if (Number.isFinite(declared) && declared > max) return null
  if (!req.body) return new Uint8Array()
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/** Decodes and resolves dot segments, as a proxy or a later router might. */
export function normalizePath(raw: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return "\0invalid"
  }
  const out: string[] = []
  for (const part of decoded.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") out.pop()
    else out.push(part)
  }
  return `/${out.join("/")}`
}

const touchesPrefix = (path: string) =>
  path.toLowerCase() === PUBLIC_PREFIX || path.toLowerCase().startsWith(`${PUBLIC_PREFIX}/`)

export function createPublicRouter(routes: PublicRoute[], options: { now?: () => number } = {}) {
  for (const route of routes)
    if (!PUBLIC_PATH.test(route.path))
      throw new Error(`Public route ${route.path} is not a plain path under ${PUBLIC_PREFIX}`)
  const limit = createRateLimiter(options.now ?? Date.now)
  const byKey = new Map(routes.map((r) => [`${r.method} ${r.path}`, r]))

  return {
    routes: routes.map((r) => `${r.method} ${r.path}`),
    /**
     * Runs before every other route: answers everything whose raw or normalized path touches the prefix, and refuses
     * paths that only reach the prefix (or leave it) after decoding or dot segments.
     */
    guard: (async (c, next) => {
      const raw = new URL(c.req.url).pathname
      const normalized = normalizePath(raw)
      const fromOutside = c.req.header(PUBLIC_INGRESS_HEADER) !== undefined
      if (!fromOutside && !touchesPrefix(raw) && !touchesPrefix(normalized)) return next()
      // Anything under /public must be the plain, exact path of a declared route.
      if (!PUBLIC_PATH.test(raw) || normalized !== raw) return c.json({ error: "not found" }, 404)
      const route = byKey.get(`${c.req.method} ${raw}`)
      if (!route) return c.json({ error: "not found" }, 404)
      const client = clientOf(c.req.raw.headers)
      const retryAfter =
        limit(`all:${route.path}`, route.rateLimit.perMinute) ??
        limit(`client:${route.path}:${client}`, route.rateLimit.perClientPerMinute)
      if (retryAfter !== null) return c.json({ error: "rate limited" }, 429, { "Retry-After": String(retryAfter) })
      const body = await readLimited(c.req.raw, route.maxBodyBytes)
      if (!body) return c.json({ error: "payload too large" }, 413)
      return route.handler({ headers: c.req.raw.headers, body })
    }) satisfies MiddlewareHandler,
  }
}
