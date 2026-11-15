import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const post = vi.fn()
vi.mock("@/env", () => ({ env: { AZURE_EMAIL_SENDER: "noreply@polinetwork.org", NODE_ENV: "test" } }))
vi.mock("@/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }))
vi.mock("@/azure/client", () => ({ getAzureClient: () => ({ api: () => ({ header: () => ({ post }) }) }) }))

const { sendEmail } = await import("@/azure/functions/emails")

/** The headers of the MIME message posted to Graph's sendMail. */
function postedHeaders(): string {
  const mime = Buffer.from(post.mock.calls[0][0] as string, "base64").toString("utf8")
  return mime.slice(0, mime.indexOf("\r\n\r\n"))
}

beforeEach(() => {
  post.mockReset()
})

describe("Graph sendMail CC", () => {
  it("adds a Cc header, which Graph turns into ccRecipients, only when CC addresses are given", async () => {
    const body = createElement("p", null, "Testo")
    await sendEmail("soci@polinetwork.org", "Oggetto", body, [], {
      cc: ["direttivo@polinetwork.org", "probiviri@polinetwork.org"],
    })
    const headers = postedHeaders()
    expect(headers).toMatch(/^To: soci@polinetwork\.org$/m)
    expect(headers).toMatch(/^Cc: direttivo@polinetwork\.org, probiviri@polinetwork\.org$/m)
  })

  it("leaves existing callers unchanged: no Cc header without CC, or with an empty list", async () => {
    const body = createElement("p", null, "Testo")
    await sendEmail("soci@polinetwork.org", "Oggetto", body)
    expect(postedHeaders()).not.toMatch(/^Cc:/im)
    post.mockReset()
    await sendEmail("soci@polinetwork.org", "Oggetto", body, [], { cc: [] })
    expect(postedHeaders()).not.toMatch(/^Cc:/im)
  })
})
