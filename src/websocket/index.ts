import { Server as Engine } from "@socket.io/bun-engine"
import { Server as SocketIOServer } from "socket.io"
import { logger } from "@/logger"
import type * as Telegram from "./telegram"

type ClientToServerEvents = Telegram.ToServer
type ServerToClientEvents = Telegram.ToClient

export interface SocketData {
  type: "telegram" | "admin"
  connectedAt: Date
}

export const engine = new Engine()

export class WebSocketServer {
  private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

  constructor() {
    this.io = new SocketIOServer()
    this.io.bind(engine)

    this.io.on("connection", (s) => {
      if ("type" in s.handshake.query && s.handshake.query.type === "telegram") {
        logger.info("[WS] Telegram socket connected")
        s.data.type = s.handshake.query.type
      } else {
        logger.info("[WS] Generic socket connected")
      }
    })
  }

  close(): Promise<Error | null> {
    return new Promise((res) => {
      this.io.close((err) => res(err ?? null))
    })
  }

  async ban(userId: number, chatId: number, durationInSeconds?: number): Promise<boolean> {
    const sockets = await this.io.fetchSockets()
    const tgSocket = sockets.find((s) => s.data.type === "telegram")
    if (!tgSocket) {
      logger.error("[WS] There is no bot websocket connected, cannot perform ban_all")
      return false
    }

    return new Promise((res) => {
      tgSocket.emit("ban", { userId, chatId, durationInSeconds }, (err) => {
        if (err) {
          logger.error({ err }, "[WS] Error occured while executing ban_all in telegram bot")
          res(false)
        } else {
          logger.info("[WS] CALLBACK OK")
          res(true)
        }
      })
    })
  }
}
