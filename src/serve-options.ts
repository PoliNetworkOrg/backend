import { MAX_PDF_BYTES } from "./esign/drive/types"

/** Bun applies one request-body limit to every route. socket.io's handler sets it to its own 1 MB frame size; the PDF uploads need 30 MB plus multipart overhead. */
export const MAX_REQUEST_BODY_BYTES = MAX_PDF_BYTES + 1024 * 1024

/** The engine's Bun.serve options with the body limit raised. socket.io keeps its own 1 MB limit for websocket frames and polling bodies. */
export function withRequestBodyLimit<T extends object>(engineOptions: T) {
  return { ...engineOptions, maxRequestBodySize: MAX_REQUEST_BODY_BYTES }
}
