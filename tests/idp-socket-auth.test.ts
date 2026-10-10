import { AuthKitError, type VerifiedToken } from "@polinetwork/auth-kit"
import { describe, expect, it } from "vitest"
import { authenticateSocket } from "@/idp/socket-auth"

const exp = 1_800_000_000
const botClientId = "registered-bot-client-7a83"

function token(overrides: Partial<VerifiedToken> = {}): VerifiedToken {
  return {
    kind: "service",
    clientId: botClientId,
    sub: botClientId,
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
    expect(await authenticateSocket(undefined, verifier(token()), botClientId)).toEqual({ kind: "anonymous" })
  })

  it("accepts the bot with backend:tg:events until its token expires", async () => {
    expect(await authenticateSocket("jwt", verifier(token()), botClientId)).toEqual({
      kind: "token",
      client: botClientId,
      expiresAt: exp * 1000,
    })
  })

  it("refuses other clients, users, missing scopes and invalid tokens", async () => {
    const rejected = { kind: "rejected" }
    expect(
      await authenticateSocket("jwt", verifier(token({ clientId: "web", sub: "web" })), botClientId)
    ).toMatchObject(rejected)
    expect(await authenticateSocket("jwt", verifier(token({ kind: "user", sub: "usr_1" })), botClientId)).toMatchObject(
      rejected
    )
    expect(
      await authenticateSocket("jwt", verifier(token({ scopes: new Set(["backend:tg:read"]) })), botClientId)
    ).toMatchObject(rejected)
    expect(
      await authenticateSocket("jwt", verifier(new AuthKitError("token_invalid", "bad signature")), botClientId)
    ).toMatchObject(rejected)
    expect(await authenticateSocket(42, verifier(token()), botClientId)).toMatchObject(rejected)
    expect(await authenticateSocket("jwt", null, botClientId)).toMatchObject(rejected)
  })

  it("refuses token handshakes when the bot client is not configured", async () => {
    expect(await authenticateSocket("jwt", verifier(token()), undefined)).toEqual({
      kind: "rejected",
      reason: "Telegram bot client is not configured",
    })
    expect(await authenticateSocket(undefined, verifier(token()), undefined)).toEqual({ kind: "anonymous" })
  })

  it("does not accept the display name as a substitute for the registered client ID", async () => {
    expect(
      await authenticateSocket("jwt", verifier(token({ clientId: "telegram-bot", sub: "telegram-bot" })), botClientId)
    ).toMatchObject({ kind: "rejected", reason: "Only the Telegram bot may connect" })
  })

  it("does not swallow unexpected errors", async () => {
    await expect(authenticateSocket("jwt", verifier(new TypeError("bug")), botClientId)).rejects.toThrow("bug")
  })
})
