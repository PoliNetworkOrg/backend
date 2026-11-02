import type { Socket } from "socket.io-client"

/** Who performed an action: the IdP subject when known, and a name for the log message. */
export type SocketActor = { sub: string | null; telegramId: string | null; displayName: string }

export type PostRegulation = {
  /** Soci group, from REGULATIONS_TELEGRAM_CHAT_ID. */
  chatId: number
  /** Forum topic (message_thread_id), from REGULATIONS_TELEGRAM_TOPIC_ID. */
  topicId: number | null
  /** Telegram HTML (parse_mode "HTML"), escaped, short enough for a caption. */
  text: string
  /** The fields behind `text`, for a bot that formats its own message. */
  regulation: {
    documentTitle: string
    draftTitle: string
    /** "Consiglio Direttivo", "Assemblea dei Soci", "Rettifica del Segretario", "Rettifica di X su delega del Segretario". */
    body: string
    /** `YYYY-MM-DD` */
    deliberaDate: string
    /** `YYYY-MM-DD`, 10 days from notification; null for a rettifica. */
    oppositionDeadline: string | null
    tag: string
    releaseUrl: string
  }
  files: { filename: string; contentType: string; data: Uint8Array }[]
}

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
  /**
   * Posts a newly emanated regulation to the Soci group (regulations editor). `text` is Telegram HTML, already escaped;
   * `files` are the official PDF and the differences PDF, in that order. Ack with the posted message ids.
   */
  postRegulation: (data: PostRegulation, cb: (error: string | null, result?: { messageIds: number[] }) => void) => void
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
