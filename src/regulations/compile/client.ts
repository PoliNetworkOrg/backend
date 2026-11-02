import type { AssetBundle, CompileRequest, CompileResponse } from "./protocol"

export type WorkerClient = { compile: (request: CompileRequest) => Promise<CompileResponse> }

/**
 * HTTP client of the LaTeX worker. When the worker doesn't have an asset bundle yet (a new version, or a restarted
 * pod with an empty tmpfs) it uploads it and tries again.
 */
export function createWorkerClient(options: {
  url: string
  secret?: string
  loadAssets: (hash: string) => Promise<AssetBundle>
  timeoutMs?: number
}): WorkerClient {
  const headers = {
    "Content-Type": "application/json",
    ...(options.secret ? { Authorization: `Bearer ${options.secret}` } : {}),
  }
  const base = options.url.replace(/\/$/, "")
  const post = async (request: CompileRequest): Promise<CompileResponse> => {
    const response = await fetch(`${base}/compile`, {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(options.timeoutMs ?? 120_000),
    })
    if (!response.ok) throw new Error(`LaTeX worker answered ${response.status}`)
    return (await response.json()) as CompileResponse
  }
  return {
    async compile(request) {
      const first = await post(request)
      if (first.status !== "assets_missing") return first
      const bundle = await options.loadAssets(request.assets)
      const upload = await fetch(`${base}/assets/${request.assets}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(bundle),
        signal: AbortSignal.timeout(60_000),
      })
      if (!upload.ok) throw new Error(`LaTeX worker refused the assets (${upload.status})`)
      const second = await post(request)
      if (second.status === "assets_missing") throw new Error("LaTeX worker lost the assets")
      return second
    },
  }
}
