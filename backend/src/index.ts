export { AUTH_PATH, TRPC_PATH, WS_PATH } from "./constants"
export type { AppRouter } from "./routers"

import type { telegramPlugin } from "./auth/plugins/telegram"
export type TelegramPlugin = typeof telegramPlugin

export type { TelegramSocket } from "./websocket/telegram"
