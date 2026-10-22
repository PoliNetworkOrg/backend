/**
 * @param time_ms The time to be awaited in milliseconds
 * @returns A promise that resolves when the time is up
 */
export function wait(time_ms: number): Promise<void> {
  return new Promise((res) => {
    setTimeout(() => {
      res()
    }, time_ms)
  })
}
export async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5): Promise<T> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await fn()
      return res
    } catch (error) {
      if (attempt === maxRetries) throw error
      await wait(2 ** attempt * 1000)
    }
  }
  throw new Error("unreachable")
}
