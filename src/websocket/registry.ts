import type { PostRegulation } from "./telegram"

/**
 * The bot's socket server, registered by `server.ts`, for modules that would otherwise import the server entrypoint.
 */
type TelegramCommands = { postRegulation(data: PostRegulation): Promise<{ messageIds: number[] }> }
let server: TelegramCommands | null = null

export function registerTelegram(commands: TelegramCommands) {
  server = commands
}

export function telegram(): TelegramCommands {
  if (!server) throw new Error("Il canale con il bot Telegram non è attivo")
  return server
}
