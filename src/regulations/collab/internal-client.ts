import type { Files } from "../contract"

/** The backend's side of the collab service's internal API. */
export type CollabControl = {
  /** The live text of a draft. */
  text(draftId: string): Promise<Files>
  /** Makes the draft hold exactly `files`, as an edit everyone sees (restore, merge). */
  replace(draftId: string, files: Files): Promise<Files>
  /** Inserts missing ids, makes every connection read-only, returns the text to freeze. */
  freeze(draftId: string): Promise<{ files: Files; parses: boolean }>
  /** Writable again: connections reconnect with new tickets. */
  reopen(draftId: string): Promise<void>
  broadcast(draftId: string, message: Record<string, unknown>): Promise<void>
  /** Re-reads the draft (state, assets) and recompiles. */
  refresh(draftId: string): Promise<void>
}

export class CollabUnavailable extends Error {}

export function createCollabControl(options: { url: string; secret: string; timeoutMs?: number }): CollabControl {
  const base = options.url.replace(/\/$/, "")
  const call = async <T>(draftId: string, action: string, body?: unknown): Promise<T> => {
    let response: Response
    try {
      response = await fetch(`${base}/drafts/${encodeURIComponent(draftId)}/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${options.secret}`, "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
    } catch (error) {
      throw new CollabUnavailable(`collab service unreachable: ${String(error)}`)
    }
    if (!response.ok) throw new CollabUnavailable(`collab service answered ${response.status} to ${action}`)
    return (await response.json()) as T
  }
  return {
    text: async (draftId) => (await call<{ files: Files }>(draftId, "text")).files,
    replace: async (draftId, files) => (await call<{ files: Files }>(draftId, "replace", { files })).files,
    freeze: (draftId) => call(draftId, "freeze"),
    reopen: async (draftId) => {
      await call(draftId, "reopen")
    },
    broadcast: async (draftId, message) => {
      await call(draftId, "broadcast", message)
    },
    refresh: async (draftId) => {
      await call(draftId, "refresh")
    },
  }
}
