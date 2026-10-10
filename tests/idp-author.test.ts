import { describe, expect, it } from "vitest"
import { authorOf } from "@/idp/author"

describe("authorOf", () => {
  it("takes token callers from the token and ignores the field they send", () => {
    expect(authorOf({ kind: "user", client: "admin-dashboard", sub: "usr_1", telegramId: "5" }, 99)).toEqual({
      id: null,
      sub: "usr_1",
    })
  })

  it("keeps the Telegram ID of legacy callers, and requires it", () => {
    expect(authorOf(null, 99)).toEqual({ id: 99, sub: null })
    expect(() => authorOf(null, undefined)).toThrow("Missing author")
  })

  it("refuses services and the bot acting for someone", () => {
    expect(() => authorOf({ kind: "service", client: "web" }, undefined)).toThrow()
    expect(() => authorOf({ kind: "telegram", client: "telegram-bot", telegramId: "5", sub: "usr_1" }, 5)).toThrow()
  })
})
