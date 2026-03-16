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
