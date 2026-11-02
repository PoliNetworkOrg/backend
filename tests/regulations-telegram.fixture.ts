import assert from "node:assert/strict"
import * as parser from "@socket.io/devalue-parser"
import { io } from "socket.io-client"

// The socket server logs through the backend's env: give it the minimum.
Object.assign(process.env, {
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_USER: "x",
  DB_PASS: "x",
  LOG_LEVEL: "warn",
})
const { engine, WebSocketServer } = await import("@/websocket")

/** postRegulation over the real Socket.IO server and devalue parser, with a client acting as the bot. */
const wss = new WebSocketServer({
  authenticate: async () => ({ kind: "token", client: "bot", expiresAt: Date.now() + 60_000 }),
})
const server = Bun.serve({ port: 0, ...engine.handler(), fetch: (req, srv) => engine.handleRequest(req, srv) })
const checked: string[] = []
const bot = io(`http://127.0.0.1:${server.port}`, {
  parser,
  auth: { token: "t" },
  transports: ["websocket"],
  path: "/ws",
})
try {
  const received: unknown[] = []
  bot.on("postRegulation", (data, cb) => {
    received.push(data)
    if (data.text === "fail") cb("Chat non trovata")
    else cb(null, { messageIds: [5, 6] })
  })
  await new Promise<void>((r, j) => {
    bot.on("connect", () => r())
    bot.on("connect_error", (e) => j(e))
    setTimeout(() => j(new Error("no connection")), 5000)
  })
  const payload = {
    chatId: -1001,
    topicId: 7,
    idempotencyKey: "notif_123",
    text: "<b>RRI</b>",
    regulation: {
      documentTitle: "RRI",
      draftTitle: "Prova",
      body: "Consiglio Direttivo",
      deliberaDate: "2026-11-20",
      oppositionDeadline: "2026-11-30",
      tag: "rri-v2026.11.20",
      releaseUrl: "https://example.org",
    },
    // About the size of the official PDF plus the differences.
    files: [
      {
        filename: "a.pdf",
        contentType: "application/pdf",
        base64: Buffer.from(new Uint8Array(400_000).fill(255)).toString("base64"),
      },
    ],
  }
  assert.deepEqual(await wss.postRegulation(payload), { messageIds: [5, 6] })
  const got = received[0] as typeof payload
  assert.equal(got.idempotencyKey, "notif_123")
  const bytes = Buffer.from(got.files[0].base64, "base64")
  assert.equal(bytes.length, 400_000)
  assert.ok(bytes.every((b) => b === 255))
  checked.push("the bot's ack returns the posted message ids; a 400 KB file arrives intact with the idempotency key")
  await assert.rejects(wss.postRegulation({ ...payload, text: "fail" }), /Chat non trovata/)
  checked.push("the bot's error comes back as the reason")
  console.log(JSON.stringify({ checked }))
} finally {
  bot.close()
  await wss.close()
  server.stop(true)
}
