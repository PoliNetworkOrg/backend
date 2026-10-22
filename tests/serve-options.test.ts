import { describe, expect, it, vi } from "vitest"
import { MAX_PDF_BYTES } from "@/esign/drive/types"
import { limitRequestBody, withRequestBodyLimit } from "@/serve-options"

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

describe("limitRequestBody", () => {
  const url = "http://localhost/ws/?EIO=4&transport=polling&sid=abc"
  const streamOf = (chunks: number[], pull = vi.fn()) =>
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pull()
          const size = chunks.shift()
          if (size === undefined) controller.close()
          else controller.enqueue(new Uint8Array(size))
        },
      },
      { highWaterMark: 0 }
    )

  it("passes a body within the limit through", async () => {
    const req = new Request(url, { method: "POST", body: "40" })
    const limited = await limitRequestBody(req, 10)
    expect(limited).toBeInstanceOf(Request)
    expect(await (limited as Request).text()).toBe("40")
    expect((limited as Request).url).toBe(url)
  })

  it("passes a request without a body through", async () => {
    const req = new Request(url)
    expect(await limitRequestBody(req, 10)).toBe(req)
  })

  it("refuses a declared length over the limit without reading the body", async () => {
    const pull = vi.fn()
    const req = new Request(url, {
      method: "POST",
      headers: { "content-length": "11" },
      body: streamOf([11], pull),
      duplex: "half",
    } as RequestInit)
    const limited = await limitRequestBody(req, 10)
    expect(limited).toBeInstanceOf(Response)
    expect((limited as Response).status).toBe(413)
    expect(pull).not.toHaveBeenCalled()
  })

  it("stops reading a streamed body once it passes the limit", async () => {
    const pull = vi.fn()
    const req = new Request(url, { method: "POST", body: streamOf([6, 6, 6, 6], pull), duplex: "half" } as RequestInit)
    const limited = await limitRequestBody(req, 10)
    expect((limited as Response).status).toBe(413)
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it("passes a streamed body within the limit through", async () => {
    const req = new Request(url, { method: "POST", body: streamOf([4, 4]), duplex: "half" } as RequestInit)
    const limited = await limitRequestBody(req, 10)
    expect((await (limited as Request).arrayBuffer()).byteLength).toBe(8)
  })
})
