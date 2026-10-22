import { MAX_PDF_BYTES } from "./esign/drive/types"

/** Bun applies one request-body limit to every route. socket.io's handler sets it to its own 1 MB frame size; the PDF uploads need 30 MB plus multipart overhead. */
export const MAX_REQUEST_BODY_BYTES = MAX_PDF_BYTES + 1024 * 1024

/** The engine's Bun.serve options with the body limit raised. socket.io keeps its own 1 MB limit for websocket frames; polling bodies go through `limitRequestBody`. */
export function withRequestBodyLimit<T extends object>(engineOptions: T) {
  return { ...engineOptions, maxRequestBodySize: MAX_REQUEST_BODY_BYTES }
}

/**
 * Reads the body up to `maxBytes` and returns a copy of the request holding it, or a 413 response past the limit.
 * socket.io's polling handler buffers the whole body before checking its size, which the raised server-wide limit
 * would let grow to 31 MB on a session that has not authenticated yet.
 */
export async function limitRequestBody(req: Request, maxBytes: number): Promise<Request | Response> {
  if (!req.body) return req
  if (Number(req.headers.get("content-length")) > maxBytes) return new Response(null, { status: 413 })

  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    size += read.value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      return new Response(null, { status: 413 })
    }
    chunks.push(read.value)
  }
  return new Request(req, { body: Buffer.concat(chunks) })
}
