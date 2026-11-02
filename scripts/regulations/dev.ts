/**
 * Starts the regulations editor's local stack on the host: the dev IdP (4300), the backend (3000) and the collab
 * service (4100 websocket, 4101 internal), against the Postgres and worker of docker/regulations-dev.compose.yaml.
 *   bun run regulations:dev
 * REGULATIONS_LEGAL_DIR defaults to ../legal next to this repository (a clone of PoliNetworkOrg/legal).
 */
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "../..")
const keys = await (async () => {
  const proc = Bun.spawn(["bun", join(root, "scripts/regulations/dev-idp.ts"), "env"], { stdout: "pipe" })
  const out = await new Response(proc.stdout).text()
  return Object.fromEntries(
    out
      .trim()
      .split("\n")
      .map((line) => {
        const at = line.indexOf("=")
        return [line.slice(0, at), line.slice(at + 1).replace(/^'|'$/g, "")]
      })
  )
})()

export const DEV_ENV: Record<string, string> = {
  NODE_ENV: "development",
  LOG_LEVEL: "info",
  DB_HOST: "127.0.0.1",
  DB_PORT: "54329",
  DB_USER: "regulations",
  DB_PASS: "regulations",
  DB_NAME: "polinetwork_backend",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  USE_DEV_MAILER: "true",
  REGULATIONS_INTERNAL_SECRET: "dev-internal-secret-0123456789abcdef",
  REGULATIONS_COLLAB_PUBLIC_URL: "ws://localhost:4100",
  REGULATIONS_COLLAB_INTERNAL_URL: "http://127.0.0.1:4101",
  REGULATIONS_WORKER_URL: "http://127.0.0.1:4200",
  REGULATIONS_WORKER_SECRET: "dev-worker-secret",
  REGULATIONS_LEGAL_DIR: process.env.REGULATIONS_LEGAL_DIR ?? resolve(root, "../legal"),
  REGULATIONS_LLM_PROVIDER: process.env.REGULATIONS_LLM_PROVIDER ?? "fake",
  REGULATIONS_GITHUB_MODE: process.env.REGULATIONS_GITHUB_MODE ?? "fake",
  COLLAB_PORT: "4100",
  COLLAB_INTERNAL_PORT: "4101",
  ...keys,
}

if (import.meta.main) {
  const env = { ...process.env, ...DEV_ENV }
  const run = (name: string, cmd: string[]) => {
    const proc = Bun.spawn(cmd, { cwd: root, env, stdout: "pipe", stderr: "pipe" })
    const pipe = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) return
        for (const line of decoder.decode(value).split("\n")) if (line.trim()) console.log(`[${name}] ${line}`)
      }
    }
    void pipe(proc.stdout)
    void pipe(proc.stderr)
    return proc
  }
  const procs = [
    run("idp", ["bun", "scripts/regulations/dev-idp.ts", "serve"]),
    run("backend", ["bun", "--watch", "src/server.ts"]),
    run("collab", ["bun", "--watch", "src/collab.ts"]),
  ]
  const stop = () => {
    for (const p of procs) p.kill()
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)
}
