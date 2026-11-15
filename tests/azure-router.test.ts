import type { Actor } from "@polinetwork/auth-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "@/trpc"

const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock("@/logger", () => ({ logger }))

const REQUIRED_ENV: Record<string, string> = {
  NODE_ENV: "test",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  DB_HOST: "localhost",
  DB_PORT: "5432",
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "polinetwork_backend_test",
}

const AZURE_CREDENTIAL_KEYS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]

async function createCaller(context: Context = {}) {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value
  for (const key of AZURE_CREDENTIAL_KEYS) delete process.env[key]

  vi.resetModules()
  const { azureRouter } = await import("@/routers/azure")
  return azureRouter.createCaller(context)
}

beforeEach(() => {
  vi.clearAllMocks()
})

/** A dashboard user holding every Azure permission the routers check. */
const ALL_AZURE = ["azure:members:read", "azure:groups:read"]

describe("Azure tRPC routes without credentials", () => {
  it("returns linked seed data for members and groups", async () => {
    const caller = await createCaller(tokenContext(ALL_AZURE))

    const members = await caller.members.getAll()
    const groups = await caller.groups.getAll()

    expect(members).toHaveLength(3)
    expect(groups).toHaveLength(3)
    expect(members.map((member) => member.id)).toContain("mock-member-ada")
    expect(groups.find((group) => group.id === "mock-group-association-members")?.members).toEqual(
      expect.arrayContaining([{ id: "mock-member-ada", displayName: "Ada Lovelace" }])
    )
  })
})

function tokenContext(
  permissions: string[],
  actor: Actor = { kind: "user", client: "admin-dashboard", sub: "usr_reader", telegramId: null },
  scopes = ["backend:admin"],
  fresh = true
): Context {
  return {
    auth: { kind: "token", actor, scopes: new Set(scopes) },
    access: {
      has: (_, permission) => fresh && permissions.includes(permission),
      current: () => null,
      subjectBySub: () => undefined,
      subjectByTelegramId: () => undefined,
      status: () => ({ lastSyncAt: 1, fresh, generation: 1, subjects: 1 }),
    },
  }
}

describe("Azure directory token authorization", () => {
  it("allows read-only dashboard users to list members", async () => {
    const caller = await createCaller(tokenContext(["azure:members:read"]))
    expect(await caller.members.getAll()).toHaveLength(3)
  })

  it.each([
    ["no permission", tokenContext([])],
    ["groups alone", tokenContext(["azure:groups:read"])],
    ["no admin scope", tokenContext(["azure:members:read"], undefined, [])],
    ["service actor", tokenContext(["azure:members:read"], { kind: "service", client: "telegram-bot" })],
    [
      "Telegram actor",
      tokenContext(["azure:members:read"], {
        kind: "telegram",
        client: "telegram-bot",
        sub: "usr_reader",
        telegramId: "123",
      }),
    ],
  ])("refuses directory reads with %s", async (_, context) => {
    const caller = await createCaller(context)
    await expect(caller.members.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses calls without a token", async () => {
    await expect((await createCaller({})).members.getAll()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})

describe("Azure group token authorization", () => {
  it("lets group readers list groups", async () => {
    const caller = await createCaller(tokenContext(["azure:groups:read"]))
    expect(await caller.groups.getAll()).not.toHaveLength(0)
  })

  it.each([
    ["no permission", tokenContext([])],
    ["member permissions alone", tokenContext(["azure:members:read"])],
    ["no admin scope", tokenContext(["azure:groups:read"], undefined, [])],
    ["service actor", tokenContext(["azure:groups:read"], { kind: "service", client: "telegram-bot" })],
  ])("refuses listing groups with %s", async (_, context) => {
    const caller = await createCaller(context)
    await expect(caller.groups.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
