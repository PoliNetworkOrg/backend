/**
 * A development-only stand-in for PoliNetwork Auth, so the local stack runs without a client registration on
 * auth.polinetwork.org. It serves what @polinetwork/auth-kit reads (JWKS, the token endpoint, the access snapshot)
 * plus the account directory, for the accounts in dev-accounts.json, and mints access tokens for them.
 *
 *   bun scripts/regulations/dev-idp.ts serve            # http://localhost:4300
 *   bun scripts/regulations/dev-idp.ts env              # the backend's IdP variables for this shim
 *   bun scripts/regulations/dev-idp.ts token --sub dev-segretario   # a bearer token (valid 2 hours)
 *
 * It never verifies client assertions and refuses to run with NODE_ENV=production.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { exportJWK, generateKeyPair, importJWK, type JWK, SignJWT } from "jose"

if (process.env.NODE_ENV === "production") {
  console.error("dev-idp is for development only")
  process.exit(1)
}

const PORT = Number(process.env.DEV_IDP_PORT ?? 4300)
const PUBLIC_URL = process.env.DEV_IDP_URL ?? `http://localhost:${PORT}`
const ISSUER = `${PUBLIC_URL}/api/auth`
const RESOURCE = process.env.OAUTH_BACKEND_RESOURCE_URI ?? "https://backend.internal.polinetwork.org"
const DASHBOARD_CLIENT = "admin-dev"
const STATE_DIR = join(import.meta.dirname, "../../.dev-idp")
const accounts: { sub: string; name: string; email: string | null; roles: string[]; permissions: string[] }[] =
  JSON.parse(readFileSync(process.env.DEV_IDP_ACCOUNTS ?? join(import.meta.dirname, "dev-accounts.json"), "utf8"))

/** The signing key and the backend client's key, kept so tokens survive restarts. */
async function keys(): Promise<{ signing: JWK; publicJwk: JWK; backendClient: JWK }> {
  const file = join(STATE_DIR, "keys.json")
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"))
  const pair = await generateKeyPair("EdDSA", { extractable: true })
  const client = await generateKeyPair("EdDSA", { extractable: true })
  const kid = `dev-${Date.now()}`
  const signing = { ...(await exportJWK(pair.privateKey)), kid, alg: "EdDSA" }
  const publicJwk = { ...(await exportJWK(pair.publicKey)), kid, alg: "EdDSA", use: "sig" }
  const backendClient = { ...(await exportJWK(client.privateKey)), kid: "backend-dev", alg: "EdDSA" }
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(file, JSON.stringify({ signing, publicJwk, backendClient }, null, 2))
  return { signing, publicJwk, backendClient }
}

async function sign(claims: Record<string, unknown>, lifetimeSec: number) {
  const { signing } = await keys()
  const key = await importJWK(signing, "EdDSA")
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "EdDSA", kid: signing.kid as string, typ: "at+jwt" })
    .setIssuer(ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + lifetimeSec)
    .setJti(crypto.randomUUID())
    .sign(key)
}

/** A dashboard user's access token for the backend (auth-kit accepts tokens up to 2 hours old). */
export async function userToken(sub: string) {
  const account = accounts.find((a) => a.sub === sub)
  if (!account) throw new Error(`unknown account ${sub}; see dev-accounts.json`)
  return sign(
    {
      sub,
      aud: RESOURCE,
      client_id: DASHBOARD_CLIENT,
      scope: "backend:admin",
      pn_subject_type: "user",
      name: account.name,
      email: account.email,
    },
    7200
  )
}

function snapshot() {
  const expiries = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { validUntil: null }]))
  return {
    schema: "polinetwork.access-snapshot/v1",
    projection: "backend",
    generation: Math.floor(Date.now() / 1000),
    builtAt: new Date().toISOString(),
    sources: {},
    subjects: accounts
      .filter((a) => a.permissions.length || a.roles.length)
      .map((a) => ({ sub: a.sub, telegramId: null, roles: expiries(a.roles), permissions: expiries(a.permissions) })),
  }
}

async function serve() {
  const { publicJwk } = await keys()
  const server = Bun.serve({
    port: PORT,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/api/auth/jwks") return Response.json({ keys: [publicJwk] })
      if (url.pathname === "/api/auth/oauth2/token" && req.method === "POST") {
        // The backend's client-credentials request (private_key_jwt): not verified here.
        const form = new URLSearchParams(await req.text())
        const clientId = form.get("client_id") ?? "backend-dev"
        const token = await sign(
          {
            sub: clientId,
            aud: form.get("resource") ?? `${PUBLIC_URL}/api/internal`,
            client_id: clientId,
            scope: form.get("scope") ?? "",
            pn_subject_type: "client",
          },
          3600
        )
        return Response.json({ access_token: token, token_type: "Bearer", expires_in: 3600 })
      }
      if (url.pathname === "/api/internal/access-snapshot") return Response.json(snapshot())
      if (url.pathname === "/api/internal/esign-users")
        return Response.json(accounts.map(({ sub, name, email }) => ({ sub, name, email })))
      if (url.pathname === "/dev/token") {
        const sub = url.searchParams.get("sub") ?? ""
        try {
          return new Response(await userToken(sub))
        } catch (error) {
          return new Response(String(error), { status: 404 })
        }
      }
      return new Response("not found", { status: 404 })
    },
  })
  console.log(`dev IdP on ${server.url} for ${accounts.length} accounts (issuer ${ISSUER})`)
}

async function printEnv() {
  const { backendClient } = await keys()
  console.log(
    [
      `IDP_PUBLIC_URL=${PUBLIC_URL}`,
      `OAUTH_BACKEND_RESOURCE_URI=${RESOURCE}`,
      `OAUTH_INTERNAL_RESOURCE_URI=${PUBLIC_URL}/api/internal`,
      "OAUTH_BACKEND_CLIENT_ID=backend-dev",
      `OAUTH_BACKEND_PRIVATE_JWK='${JSON.stringify(backendClient)}'`,
      "IDP_SNAPSHOT_POLL_INTERVAL_MS=5000",
    ].join("\n")
  )
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2)
  if (command === "serve") await serve()
  else if (command === "env") await printEnv()
  else if (command === "token") {
    const sub = args[args.indexOf("--sub") + 1]
    console.log(await userToken(sub))
  } else {
    console.error("usage: dev-idp.ts serve | env | token --sub <sub>")
    process.exit(1)
  }
}
