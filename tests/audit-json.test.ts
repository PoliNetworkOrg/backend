import { describe, expect, it } from "vitest"
import { auditJson } from "@/audit"

describe("auditJson", () => {
  it("hides secrets and describes files instead of copying them", () => {
    const form = new FormData()
    form.set("name", "PoliNetwork")
    form.set("logo", new File([new Uint8Array(3)], "logo.png", { type: "image/png" }))
    expect(
      auditJson({
        form,
        password: "hunter2",
        ticket: "abc",
        idempotencyKey: "k",
        bytes: new Uint8Array(4),
        at: new Date(0),
      })
    ).toEqual({
      form: { name: "PoliNetwork", logo: { file: "logo.png", type: "image/png", size: 3 } },
      password: "(hidden)",
      ticket: "(hidden)",
      idempotencyKey: "(hidden)",
      bytes: "(4 bytes)",
      at: "1970-01-01T00:00:00.000Z",
    })
  })

  it("cuts long strings and arrays", () => {
    const copy = auditJson({ text: "x".repeat(2500), list: Array.from({ length: 103 }, (_, i) => i) })
    expect(copy).toMatchObject({ text: `${"x".repeat(2000)}… (2500 characters)` })
    expect((copy as { list: unknown[] }).list).toHaveLength(101)
    expect((copy as { list: unknown[] }).list.at(-1)).toBe("(3 more)")
  })
})
