export { TRPC_PATH, AUTH_PATH } from "./constants"
export { type AppRouter } from "./routers"
import type { telegramPlugin } from "./auth/plugins/telegram"

export type TelegramPlugin = typeof telegramPlugin
