import { describe, expect, it } from "vitest"
import { MAX_PDF_BYTES } from "@/esign/drive/types"
import { withRequestBodyLimit } from "@/serve-options"

describe("serve options", () => {
  // What @socket.io/bun-engine's handler() returns, without its handlers.
  const engineOptions = { maxRequestBodySize: 1e6, idleTimeout: 50, websocket: { maxPayloadLength: 1e6 } }

  it("raises the request body limit above the largest PDF", () => {
    expect(withRequestBodyLimit(engineOptions).maxRequestBodySize).toBeGreaterThan(MAX_PDF_BYTES)
  })

  it("keeps socket.io's websocket frame limit and idle timeout", () => {
    const options = withRequestBodyLimit(engineOptions)
    expect(options.websocket.maxPayloadLength).toBe(1e6)
    expect(options.idleTimeout).toBe(50)
  })
})
