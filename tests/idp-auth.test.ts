import { AuthKitError, parseAccessSnapshot, type VerifiedToken } from "@polinetwork/auth-kit"
import { describe, expect, it } from "vitest"
import { authenticate } from "@/idp/auth"

const snapshot = parseAccessSnapshot(
  JSON.stringify({
    schema: "polinetwork.access-snapshot/v1",
    projection: "backend",
    generation: 1,
    builtAt: "2026-10-09T10:00:00.000Z",
    sources: {},
    subjects: [{ sub: "usr_mod", telegramId: "123", permissions: { "tg:moderate": { validUntil: null } } }],
  }),
  "backend"
)

const bot: VerifiedToken = {
  kind: "service",
  clientId: "telegram-bot",
  sub: "telegram-bot",
  scopes: new Set(["backend:tg:read", "backend:tg:act-as"]),
  claims: {},
}

const authenticator = (result: VerifiedToken | AuthKitError) => ({
  verify: async () => {
    if (result instanceof AuthKitError) throw result
    return result
  },
  snapshot: { current: () => snapshot },
})

describe("authenticate", () => {
  it("treats a request without a token as anonymous", async () => {
    expect(await authenticate({}, authenticator(bot))).toEqual({ kind: "anonymous" })
  })

  it("never lets an actor header or a token fall back to the legacy path", async () => {
    expect(await authenticate({ actor: "telegram:123" }, authenticator(bot))).toMatchObject({
      kind: "rejected",
      status: 401,
    })
    expect(await authenticate({ authorization: "Basic abc" }, authenticator(bot))).toMatchObject({
      kind: "rejected",
      status: 401,
    })
    expect(await authenticate({ authorization: "Bearer abc" }, { verify: null, snapshot: null })).toMatchObject({
      kind: "rejected",
      status: 401,
    })
  })

  it("maps verification failures to 401, 403 and 503", async () => {
    const bearer = { authorization: "Bearer a.b.c" }
    expect(await authenticate(bearer, authenticator(new AuthKitError("token_invalid", "bad")))).toMatchObject({
      status: 401,
    })
    expect(await authenticate(bearer, authenticator(new AuthKitError("keys_unavailable", "down")))).toMatchObject({
      status: 503,
    })
    expect(
      await authenticate(
        { ...bearer, actor: "telegram:123" },
        authenticator({ ...bot, scopes: new Set(["backend:tg:read"]) })
      )
    ).toMatchObject({ status: 403 })
  })

  it("accepts the bearer scheme in any case", async () => {
    expect(await authenticate({ authorization: "bearer a.b.c" }, authenticator(bot))).toMatchObject({ kind: "token" })
  })

  it("resolves the bot acting for a Telegram user through the snapshot", async () => {
    expect(await authenticate({ authorization: "Bearer a.b.c", actor: "telegram:123" }, authenticator(bot))).toEqual({
      kind: "token",
      actor: { kind: "telegram", client: "telegram-bot", telegramId: "123", sub: "usr_mod" },
      scopes: bot.scopes,
    })
  })
})
