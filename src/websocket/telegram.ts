import type { Socket } from "socket.io-client"

/** Who performed an action: the IdP subject when known, and a name for the log message. */
export type SocketActor = { sub: string | null; telegramId: string | null; displayName: string }

// the backend ask the telegram bot to do something
export interface ToClient {
  ban: (
    data: {
      chatId: number
      userId: number
      durationInSeconds?: number
    },
    cb: (error: string | null) => void
  ) => void

  logGrantCreate: (
    data: {
      userId: number
      actor: SocketActor
      validSince: Date
      validUntil: Date
      reason?: string
    },
    cb: (error: string | null) => void
  ) => void
  logGrantInterrupt: (
    data: {
      userId: number
      actor: SocketActor
    },
    cb: (error: string | null) => void
  ) => void
  leaveChat: (
    data: {
      chatId: number
      performer: SocketActor
    },
    cb: (ok: boolean) => void
  ) => void
}

// the telegram bot answers the backend
// biome-ignore lint/complexity/noBannedTypes: no events yet
export type ToServer = {}

export type TelegramSocket = Socket<ToClient, ToServer>
