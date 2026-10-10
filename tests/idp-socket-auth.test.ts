import { AuthKitError, type VerifiedToken } from "@polinetwork/auth-kit"
import { describe, expect, it } from "vitest"
import { authenticateSocket } from "@/idp/socket-auth"

const exp = 1_800_000_000

function token(overrides: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    kind: "service",
    clientId: "telegram-bot",
    sub: "telegram-bot",
    scopes: new Set(["backend:tg:events"]),
    claims: { exp },
    ...overrides,
  }
}

const verifier = (result: VerifiedToken | Error) => async () => {
  if (result instanceof Error) throw result
  return result
}

describe("authenticateSocket", () => {
  it("leaves a handshake without a token to the legacy path", async () => {
    expect(await authenticateSocket(undefined, verifier(token()))).toEqual({ kind: "anonymous" })
  })

  it("accepts the bot with backend:tg:events until its token expires", async () => {
    expect(await authenticateSocket("jwt", verifier(token()))).toEqual({
      kind: "token",
      client: "telegram-bot",
      expiresAt: exp * 1000,
    })
  })

  it("refuses other clients, users, missing scopes and invalid tokens", async () => {
    const rejected = { kind: "rejected" }
    expect(await authenticateSocket("jwt", verifier(token({ clientId: "web", sub: "web" })))).toMatchObject(rejected)
    expect(await authenticateSocket("jwt", verifier(token({ kind: "user", sub: "usr_1" })))).toMatchObject(rejected)
    expect(await authenticateSocket("jwt", verifier(token({ scopes: new Set(["backend:tg:read"]) })))).toMatchObject(
      rejected
    )
    expect(await authenticateSocket("jwt", verifier(new AuthKitError("token_invalid", "bad signature")))).toMatchObject(
      rejected
    )
    expect(await authenticateSocket(42, verifier(token()))).toMatchObject(rejected)
    expect(await authenticateSocket("jwt", null)).toMatchObject(rejected)
  })

  it("does not swallow unexpected errors", async () => {
    await expect(authenticateSocket("jwt", verifier(new TypeError("bug")))).rejects.toThrow("bug")
  })
})
