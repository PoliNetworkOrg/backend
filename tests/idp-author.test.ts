import { describe, expect, it } from "vitest"
import { authorOf } from "@/idp/author"

describe("authorOf", () => {
  it("takes the author from the token's user", () => {
    expect(authorOf({ kind: "user", client: "admin-dashboard", sub: "usr_1", telegramId: "5" })).toEqual({
      sub: "usr_1",
    })
  })

  it("refuses services and the bot acting for someone", () => {
    expect(() => authorOf({ kind: "service", client: "web" })).toThrow()
    expect(() => authorOf({ kind: "telegram", client: "telegram-bot", telegramId: "5", sub: "usr_1" })).toThrow()
  })
})
