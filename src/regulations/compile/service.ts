import type { CompileStatus } from "../contract"
import type { WorkerClient } from "./client"
import { type CompileResult, sourceHash } from "./protocol"
import { createLatestWinsQueue } from "./queue"

export type CachedCompile = Pick<CompileResult, "ok" | "errors" | "log">

export type CompileStore = {
  findCompile(hash: string): Promise<CachedCompile | null>
  /** Stores the result (and the PDF as a blob when `ok`). */
  saveCompile(hash: string, result: CompileResult): Promise<void>
  /** Marks `hash` as compiled for the draft, so `compile.pdf` may serve it. */
  addRef(draftId: string, hash: string): Promise<void>
  setDraftStatus(
    draftId: string,
    /** `goodHash`: a successful compile to keep as the last good PDF. */
    status: { state: CompileStatus["state"]; hash: string; goodHash?: string; error?: string | null }
  ): Promise<void>
}

export type CompileJob = { draftId: string; entry: string; assets: string; files: Record<string, string> }

export type CompileEvent = { draftId: string; hash: string; state: CompileStatus["state"] }

/**
 * Compiles drafts through the worker: one compile in flight per draft, latest wins, at most `concurrency` overall,
 * cached by source hash (shared across drafts and viewers). Each state change is stored for `compile.status` and
 * reported through `onEvent` (the collab service broadcasts it to the draft's connections).
 */
export function createCompiler(options: {
  store: CompileStore
  worker: WorkerClient
  concurrency?: number
  onEvent?: (event: CompileEvent) => void
  onError?: (error: unknown, job: CompileJob) => void
}) {
  const queue = createLatestWinsQueue<void>(options.concurrency ?? 3)
  /** The hash last requested per draft, to skip repeats (the same text saved twice). */
  const latest = new Map<string, string>()
  const emit = (event: CompileEvent) => options.onEvent?.(event)

  async function request(job: CompileJob): Promise<string> {
    const hash = await sourceHash({ entry: job.entry, files: job.files, assets: job.assets })
    if (latest.get(job.draftId) === hash) return hash
    latest.set(job.draftId, hash)
    await options.store.addRef(job.draftId, hash)
    const cached = await options.store.findCompile(hash)
    if (cached) {
      const state = cached.ok ? "ok" : "error"
      await options.store.setDraftStatus(job.draftId, {
        state,
        hash,
        goodHash: cached.ok ? hash : undefined,
        error: null,
      })
      emit({ draftId: job.draftId, hash, state })
      return hash
    }
    await options.store.setDraftStatus(job.draftId, { state: "queued", hash })
    emit({ draftId: job.draftId, hash, state: "queued" })
    void queue
      .schedule(job.draftId, async () => {
        if (latest.get(job.draftId) !== hash) return
        await options.store.setDraftStatus(job.draftId, { state: "running", hash })
        emit({ draftId: job.draftId, hash, state: "running" })
        try {
          const response = await options.worker.compile({
            key: job.draftId,
            hash,
            entry: job.entry,
            assets: job.assets,
            files: job.files,
          })
          if (response.status !== "done") return
          const { status: _, ...result } = response
          await options.store.saveCompile(hash, result)
          const state = result.ok ? "ok" : "error"
          // A newer text may be waiting: its own status follows; this result still counts as the last good PDF.
          if (latest.get(job.draftId) === hash) {
            await options.store.setDraftStatus(job.draftId, {
              state,
              hash,
              goodHash: result.ok ? hash : undefined,
              error: null,
            })
            emit({ draftId: job.draftId, hash, state })
          } else if (result.ok) {
            const newer = latest.get(job.draftId) ?? hash
            await options.store.setDraftStatus(job.draftId, { state: "queued", hash: newer, goodHash: hash })
          }
        } catch (error) {
          options.onError?.(error, job)
          // Not cached: the same text compiles again on the next request.
          latest.delete(job.draftId)
          await options.store.setDraftStatus(job.draftId, {
            state: "error",
            hash,
            error: "Il compilatore non è raggiungibile: riprovo alla prossima modifica.",
          })
          emit({ draftId: job.draftId, hash, state: "error" })
        }
      })
      .catch((error) => options.onError?.(error, job))
    return hash
  }

  return { request, stats: queue.stats }
}
