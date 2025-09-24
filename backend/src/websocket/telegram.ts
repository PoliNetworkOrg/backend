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
}

// the telegram bot answers the backend
// biome-ignore lint/complexity/noBannedTypes: no events yet
export type ToServer = {}

export type TelegramSocket = Socket<ToClient, ToServer>
