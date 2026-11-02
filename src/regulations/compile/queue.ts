export type Scheduled<T> = { status: "done"; value: T } | { status: "superseded" }

type Pending<T> = { run: () => Promise<T>; resolve: (r: Scheduled<T>) => void; reject: (e: unknown) => void }

/**
 * At most one job in flight per key and `concurrency` overall; a job waiting for its key is replaced by a newer one
 * (latest wins), and the replaced caller is told so. Used for compiles: one per draft, a few in parallel.
 */
export function createLatestWinsQueue<T>(concurrency: number) {
  const running = new Set<string>()
  const pending = new Map<string, Pending<T>>()
  /** Keys with a pending job, in arrival order, waiting for a free slot. */
  const ready: string[] = []
  let active = 0

  const pump = () => {
    for (let i = 0; i < ready.length && active < concurrency; ) {
      const key = ready[i]
      if (running.has(key)) {
        i++
        continue
      }
      ready.splice(i, 1)
      const job = pending.get(key)
      if (!job) continue
      pending.delete(key)
      running.add(key)
      active++
      job
        .run()
        .then(
          (value) => job.resolve({ status: "done", value }),
          (error) => job.reject(error)
        )
        .finally(() => {
          running.delete(key)
          active--
          pump()
        })
    }
  }

  return {
    schedule(key: string, run: () => Promise<T>): Promise<Scheduled<T>> {
      return new Promise<Scheduled<T>>((resolve, reject) => {
        const previous = pending.get(key)
        if (previous) previous.resolve({ status: "superseded" })
        else ready.push(key)
        pending.set(key, { run, resolve, reject })
        pump()
      })
    },
    /** Whether a job for `key` is running or waiting. */
    busy: (key: string) => running.has(key) || pending.has(key),
    stats: () => ({ active, waiting: pending.size }),
  }
}
