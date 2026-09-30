import { createServer, type Server, type Socket } from "node:net"
import type { RedisClientOptions } from "redis"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fixtures = vi.hoisted(() => ({
  env: { REDIS_HOST: "127.0.0.1", REDIS_PORT: 0 },
  logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

vi.mock("@/env", () => ({ env: fixtures.env }))
vi.mock("@/logger", () => ({ logger: fixtures.logger }))
vi.mock("redis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("redis")>()
  return {
    ...actual,
    createClient: (options: RedisClientOptions) => {
      const strategy = options.socket?.reconnectStrategy
      return actual.createClient({
        ...options,
        // The test server implements the handshake and RPUSH. Retry decisions and the client
        // are real; only the delay is shortened to keep outage tests fast.
        disableClientInfo: true,
        socket: {
          ...options.socket,
          reconnectStrategy: (retries, cause) => {
            const delay = typeof strategy === "function" ? strategy(retries, cause) : strategy
            return typeof delay === "number" ? 5 : (delay ?? 5)
          },
        },
      })
    },
  }
})

let server: Server
let sockets: Set<Socket>
let client: typeof import("@/redis")["redis"] | undefined

async function listen(port = 0) {
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected TCP address")
  fixtures.env.REDIS_PORT = address.port
}

async function stopServer() {
  for (const socket of sockets) socket.destroy()
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function waitForRetry(attempt: number) {
  await vi.waitFor(() => {
    expect(fixtures.logger.debug).toHaveBeenCalledWith(`[REDIS] reconnect retry #${attempt}`)
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  sockets = new Set()
  server = createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {}) // Connections are deliberately reset by outage tests.
    socket.on("close", () => sockets.delete(socket))
    let request = ""
    socket.on("data", (chunk) => {
      request += chunk.toString()
      while (request.length > 0) {
        const headerEnd = request.indexOf("\r\n")
        if (headerEnd < 0) return
        const count = Number(request.slice(1, headerEnd))
        let offset = headerEnd + 2
        const args: string[] = []
        for (let i = 0; i < count; i++) {
          const lengthEnd = request.indexOf("\r\n", offset)
          if (lengthEnd < 0) return
          const length = Number(request.slice(offset + 1, lengthEnd))
          if (request.length < lengthEnd + 2 + length + 2) return
          args.push(request.slice(lengthEnd + 2, lengthEnd + 2 + length))
          offset = lengthEnd + 2 + length + 2
        }
        request = request.slice(offset)
        if (args[0] === "HELLO") {
          socket.write("%2\r\n+proto\r\n:3\r\n+version\r\n+7.2.0\r\n")
        } else if (args[0] === "CLIENT") socket.write("+OK\r\n")
        else if (args[0] === "RPUSH" && args[2] === "entry") socket.write(":1\r\n")
        else socket.write("-ERR unsupported test command\r\n")
      }
    })
  })
})

afterEach(async () => {
  if (client?.isOpen) await client.disconnect()
  client = undefined
  await stopServer()
})

describe("Redis outage recovery", () => {
  it("runs RPUSH after Redis starts later than the initial retry budget", async () => {
    await listen()
    const port = fixtures.env.REDIS_PORT
    await stopServer()
    client = (await import("@/redis")).redis
    await waitForRetry(3)

    await listen(port)
    await expect(client.rPush("moderation:test", "entry")).resolves.toBe(1)
    expect(client.isReady).toBe(true)
  })

  it("runs RPUSH after a connected server outlasts the reconnect budget", async () => {
    await listen()
    const port = fixtures.env.REDIS_PORT
    client = (await import("@/redis")).redis
    await vi.waitFor(() => expect(client?.isReady).toBe(true))
    await stopServer()
    await waitForRetry(5)

    await listen(port)
    await expect(client.rPush("moderation:test", "entry")).resolves.toBe(1)
    expect(client.isReady).toBe(true)
  })
})
