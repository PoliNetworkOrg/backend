// the backend ask the telegram bot to do something
export interface ToClient {
  ban: (
    data: {
      chatId: number
      userId: number
      durationInSeconds?: number
    },
    onSuccess: () => void,
    onError: (error: string) => void
  ) => void
}

// the telegram bot answers the backend
export type ToServer = {
  registerTg: () => void
}
