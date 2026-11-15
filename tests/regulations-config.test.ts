import { beforeAll, describe, expect, it } from "vitest"

Object.assign(process.env, {
  NODE_ENV: "test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  LOG_LEVEL: "silent",
})
let parse: typeof import("@/regulations/config").parseRegulationsConfig
beforeAll(async () => {
  parse = (await import("@/regulations/config")).parseRegulationsConfig
})

describe("regulations settings", () => {
  it("treat malformed values as unset instead of stopping the backend", () => {
    const config = parse({
      REGULATIONS_LLM_PROVIDER: "openai",
      REGULATIONS_WORKER_URL: "not a url",
      REGULATIONS_INTERNAL_SECRET: "short",
      REGULATIONS_RECONCILE_SECONDS: "a minute",
      REGULATIONS_TELEGRAM_CHAT_ID: "-100abc",
      REGULATIONS_EMAIL_TO: "soci",
      REGULATIONS_GITHUB_MODE: "",
      REGULATIONS_COLLAB_PUBLIC_URL: "wss://collab.polinetwork.org",
    })
    expect(config.REGULATIONS_LLM_PROVIDER).toBeUndefined()
    expect(config.REGULATIONS_WORKER_URL).toBeUndefined()
    expect(config.REGULATIONS_INTERNAL_SECRET).toBeUndefined()
    expect(config.REGULATIONS_TELEGRAM_CHAT_ID).toBeUndefined()
    expect(config.REGULATIONS_GITHUB_MODE).toBeUndefined()
    // Defaults still apply where a value was malformed or missing.
    expect(config.REGULATIONS_RECONCILE_SECONDS).toBe(300)
    expect(config.REGULATIONS_EMAIL_TO).toBe("soci@polinetwork.org")
    expect(config.REGULATIONS_GITHUB_BASE).toBe("main")
    expect(config.REGULATIONS_COLLAB_PUBLIC_URL).toBe("wss://collab.polinetwork.org")
  })

  it("parse what polinetwork-cd sets", () => {
    const config = parse({
      REGULATIONS_GITHUB_MODE: "app",
      REGULATIONS_GITHUB_BASE: "main",
      REGULATIONS_GITHUB_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nabc\\n-----END RSA PRIVATE KEY-----",
      REGULATIONS_TELEGRAM_CHAT_ID: "-1001234567890",
      REGULATIONS_RECONCILE_SECONDS: "300",
    })
    expect(config.REGULATIONS_GITHUB_MODE).toBe("app")
    expect(config.REGULATIONS_GITHUB_PRIVATE_KEY).toContain("KEY-----\nabc\n-----END")
    expect(config.REGULATIONS_TELEGRAM_CHAT_ID).toBe(-1001234567890)
  })
})
