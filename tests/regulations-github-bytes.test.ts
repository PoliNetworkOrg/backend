import { generateKeyPairSync } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { githubAppClient } from "@/regulations/emanation/github"

/**
 * GitHub sends raw file contents as `application/vnd.github.raw+json; charset=utf-8`, fonts included. Octokit decodes
 * such a body as text unless told not to parse it, which corrupted the fonts read from the legal repository.
 */
const RAW_TYPE = "application/vnd.github.raw+json; charset=utf-8"

// Not valid UTF-8: a TTF header, lone continuation bytes, an overlong form, 0xFF, a truncated sequence, and NUL.
const binary = new Uint8Array([
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x12,
  0x80,
  0xbf,
  0xc0,
  0xaf,
  0xff,
  0xfe,
  0xe2,
  0x82,
  0x00,
  0xf0,
  0x9f,
  0x98,
  ...Array.from({ length: 256 }, (_, i) => i),
])
// A few MB, so a large font or image goes through as well.
const large = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 2654435761) >>> 24)

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
})

const files: Record<string, { body: Uint8Array; type: string }> = {
  "rri/latex/fonts/Ubuntu/Ubuntu-Light.ttf": { body: binary, type: RAW_TYPE },
  "rri/latex/fonts/big.otf": { body: large, type: RAW_TYPE },
  "rri/latex/RRI.tex": { body: new TextEncoder().encode("\\articolo{Perché}\n«virgolette» €\n"), type: RAW_TYPE },
  "empty.txt": { body: new Uint8Array(), type: RAW_TYPE },
}
const seen: { path: string; accept: string | null }[] = []

function fakeGitHubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init)
  const url = new URL(request.url)
  const path = decodeURIComponent(url.pathname)
  seen.push({ path, accept: request.headers.get("accept") })
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } })
  if (path === "/repos/PoliNetworkOrg/legal/installation") return Promise.resolve(json({ id: 7 }))
  if (path === "/app/installations/7/access_tokens")
    return Promise.resolve(json({ token: "ghs_x", expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201))
  const content = /^\/repos\/PoliNetworkOrg\/legal\/contents\/(.+)$/.exec(path)
  if (content) {
    const file = files[content[1]]
    if (!file) return Promise.resolve(json({ message: "Not Found" }, 404))
    return Promise.resolve(new Response(file.body.slice(), { status: 200, headers: { "content-type": file.type } }))
  }
  if (path === "/repos/PoliNetworkOrg/legal/releases/assets/5")
    return Promise.resolve(
      new Response(binary.slice(), { status: 200, headers: { "content-type": "application/pdf; charset=utf-8" } })
    )
  return Promise.resolve(json({ message: `unexpected ${path}` }, 500))
}

beforeEach(() => {
  seen.length = 0
  vi.stubGlobal("fetch", vi.fn(fakeGitHubFetch))
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const client = () => githubAppClient({ appId: "1", privateKey, repo: "PoliNetworkOrg/legal" })

describe("githubAppClient reads repository files byte for byte", () => {
  it("returns a binary file served with a charset=utf-8 content type exactly", async () => {
    const bytes = await client().readBytes("rri/latex/fonts/Ubuntu/Ubuntu-Light.ttf", "main")
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(Buffer.from(bytes as Uint8Array).equals(Buffer.from(binary))).toBe(true)
    expect(seen.find((r) => r.path.endsWith("Ubuntu-Light.ttf"))?.accept).toBe("application/vnd.github.raw+json")
  })

  it("returns a file of a few MB exactly", async () => {
    const bytes = await client().readBytes("rri/latex/fonts/big.otf", "main")
    expect(bytes?.byteLength).toBe(large.byteLength)
    expect(Buffer.from(bytes as Uint8Array).equals(Buffer.from(large))).toBe(true)
  })

  it("still reads UTF-8 text, empty files, and null for a missing file", async () => {
    const gh = client()
    expect(await gh.readText("rri/latex/RRI.tex", "main")).toBe("\\articolo{Perché}\n«virgolette» €\n")
    expect(await gh.readBytes("empty.txt", "main")).toEqual(new Uint8Array())
    expect(await gh.readBytes("missing.tex", "main")).toBeNull()
  })

  it("downloads a release asset exactly, whatever its content type says", async () => {
    const bytes = await client().downloadAsset(5)
    expect(Buffer.from(bytes).equals(Buffer.from(binary))).toBe(true)
  })
})
