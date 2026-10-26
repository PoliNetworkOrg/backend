import { Server as Engine } from "@socket.io/bun-engine"
import * as parser from "@socket.io/devalue-parser"
import { type Socket, Server as SocketIOServer } from "socket.io"
import type { SocketAuth } from "@/idp/socket-auth"
import { logger } from "@/logger"
import type * as Telegram from "./telegram"

type ClientToServerEvents = Telegram.ToServer
type ServerToClientEvents = Telegram.ToClient

export interface SocketData {
  connectedAt: Date
}

type ServerSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

export type WebSocketServerOptions = {
  /** Checks the handshake's `auth.token`; only the Telegram bot's token is accepted (RFC v3 §8.3). */
  authenticate: (token: unknown) => Promise<SocketAuth>
}

/** A missing acknowledgement must not hang the request that triggered the emit. */
const ACK_TIMEOUT_MS = 10_000
/** People pages wait on this read: without the bot, they show groups without admins instead of hanging. */
const READ_TIMEOUT_MS = 3_000

export const engine = new Engine()

export class WebSocketServer {
  private io: SocketIOServer<ClientToServerEvents, ServerToClientEvents, Record<string, never>, SocketData>

  constructor(options: WebSocketServerOptions) {
    this.io = new SocketIOServer({ parser })
    this.io.bind(engine)

    this.io.use((socket, next) => {
      options.authenticate(socket.handshake.auth?.token).then(
        (auth) => {
          if (auth.kind === "rejected") {
            logger.warn({ reason: auth.reason }, "[WS] socket rejected")
            return next(new Error("Unauthorized"))
          }
          // The bot reconnects with a fresh token.
          const timer = setTimeout(() => socket.disconnect(true), Math.max(0, auth.expiresAt - Date.now()))
          socket.on("disconnect", () => clearTimeout(timer))
          next()
        },
        (error: unknown) => {
          logger.error({ error }, "[WS] socket authentication failed")
          next(new Error("Unauthorized"))
        }
      )
    })

    this.io.on("connection", (s) => {
      s.data.connectedAt = new Date()
      logger.info("[WS] Telegram socket connected with a token")
    })
  }

  close(): Promise<Error | null> {
    return new Promise((res) => {
      this.io.close((err) => res(err ?? null))
    })
  }

  /**
   * The bot's socket. While the bot reconnects with a fresh token, the newest connection is the one
   * that will not be cut at `exp`.
   */
  private telegramSocket(action: string): ServerSocket | null {
    let socket: ServerSocket | null = null
    for (const candidate of this.io.of("/").sockets.values())
      if (!socket || candidate.data.connectedAt > socket.data.connectedAt) socket = candidate
    if (!socket) logger.error(`[WS] There is no bot websocket connected, cannot perform ${action}`)
    return socket
  }

  async ban(userId: number, chatId: number, durationInSeconds?: number): Promise<boolean> {
    const tgSocket = this.telegramSocket("ban_all")
    if (!tgSocket) return false

    return new Promise((res) => {
      tgSocket.timeout(ACK_TIMEOUT_MS).emit("ban", { userId, chatId, durationInSeconds }, (timeout, err) => {
        if (timeout || err) {
          logger.error({ err: timeout ?? err }, "[WS] Error occured while executing ban_all in telegram bot")
          res(false)
        } else {
          logger.info("[WS] CALLBACK OK")
          res(true)
        }
      })
    })
  }

  async logGrantCreate(data: Parameters<ServerToClientEvents["logGrantCreate"]>[0]): Promise<boolean> {
    const tgSocket = this.telegramSocket("logGrantCreate")
    if (!tgSocket) return false

    return new Promise((res) => {
      tgSocket.timeout(ACK_TIMEOUT_MS).emit("logGrantCreate", data, (timeout, err) => {
        if (timeout || err) {
          logger.error({ err: timeout ?? err }, "[WS] Error occured while logging in telegram bot")
          res(false)
        } else {
          res(true)
        }
      })
    })
  }

  async logGrantInterrupt(data: Parameters<ServerToClientEvents["logGrantInterrupt"]>[0]): Promise<boolean> {
    const tgSocket = this.telegramSocket("logGrantInterrupt")
    if (!tgSocket) return false

    return new Promise((res) => {
      tgSocket.timeout(ACK_TIMEOUT_MS).emit("logGrantInterrupt", data, (timeout, err) => {
        if (timeout || err) {
          logger.error({ err: timeout ?? err }, "[WS] Error occured while logging in telegram bot")
          res(false)
        } else {
          res(true)
        }
      })
    })
  }

  /** Each group's Telegram admins as the bot knows them, or null when the bot does not answer. */
  async getGroupAdmins(chatIds: number[]): Promise<Map<number, number[]> | null> {
    const tgSocket = this.telegramSocket("getGroupAdmins")
    if (!tgSocket) return null

    return new Promise((res) => {
      tgSocket.timeout(READ_TIMEOUT_MS).emit("getGroupAdmins", { chatIds }, (timeout, groups) => {
        if (timeout) {
          logger.error({ err: timeout }, "[WS] Cannot read the groups' admins from the bot")
          res(null)
        } else {
          res(new Map(groups.map((group) => [group.chatId, group.userIds])))
        }
      })
    })
  }

  async leaveChat(data: Parameters<ServerToClientEvents["leaveChat"]>[0]): Promise<boolean> {
    const tgSocket = this.telegramSocket("leaveChat")
    if (!tgSocket) return false

    return new Promise<boolean>((res) => {
      tgSocket.timeout(ACK_TIMEOUT_MS).emit("leaveChat", data, (timeout, ok) => {
        if (timeout || !ok) {
          logger.error({ chatId: data.chatId, err: timeout }, "[WS] Cannot leave the chat")
          res(false)
        } else {
          res(true)
        }
      })
    })
  }
}
