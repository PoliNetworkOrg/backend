export { AUTH_PATH, TRPC_PATH, WS_PATH } from "./constants"
export type { AppRouter } from "./routers"

import type { Socket } from "socket.io-client"
import type { telegramPlugin } from "./auth/plugins/telegram"
import type * as TelegramWSTypes from "./websocket/telegram"

export type TelegramPlugin = typeof telegramPlugin
export type TelegramSocket = Socket<TelegramWSTypes.ToClient, TelegramWSTypes.ToServer>
