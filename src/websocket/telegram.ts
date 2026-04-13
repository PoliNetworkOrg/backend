import type { Socket } from "socket.io-client"

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
      adminId: number
      validSince: Date
      validUntil: Date
      reason?: string
    },
    cb: (error: string | null) => void
  ) => void
  logGrantInterrupt: (data: { userId: number; adminId: number }, cb: (error: string | null) => void) => void
  leaveChat: (data: { chatId: number; performerId: number }, cb: (ok: boolean) => void) => void
}

// the telegram bot answers the backend
// biome-ignore lint/complexity/noBannedTypes: no events yet
export type ToServer = {}

export type TelegramSocket = Socket<ToClient, ToServer>
