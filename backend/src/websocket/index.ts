import type { ServerType } from "@hono/node-server"
import { Server as SocketIOServer } from "socket.io"
import { logger } from "@/logger"
import type * as Telegram from "./telegram"

type ClientToServerEvents = Telegram.ToServer
type ServerToClientEvents = Telegram.ToClient

export interface SocketData {
  type: "telegram" | "admin"
  connectedAt: Date
}

export class WebsocketServer {
  private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

  constructor(httpServer: ServerType, path: string = "/ws") {
    this.io = new SocketIOServer(httpServer, {
      path,
      // TODO: implement SuperJSON parser
      serveClient: false,
    })

    this.io.on("connection", (s) => {
      if ("type" in s.handshake.query && s.handshake.query.type === "telegram") {
        logger.info("[WS] Telegram socket connected")
        s.data.type = s.handshake.query.type
      } else {
        logger.info("[WS] Generic socket connected")
      }
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
      tgSocket.emit(
        "ban",
        { userId, chatId, durationInSeconds },
        () => {
          res(true)
        },
        (err) => {
          logger.error({ err }, "[WS] Error occured while executing ban_all in telegram bot")
          res(false)
        }
      )
    })
  }
}
