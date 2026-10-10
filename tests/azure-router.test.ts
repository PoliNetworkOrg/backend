import type { Actor } from "@polinetwork/auth-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "@/trpc"

vi.mock("@/emails/mailer", () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
}))

const REQUIRED_ENV: Record<string, string> = {
  NODE_ENV: "test",
  BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
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

describe("Azure tRPC routes without credentials", () => {
  it("returns linked seed data for members and groups", async () => {
    const caller = await createCaller()

    const members = await caller.members.getAll()
    const groups = await caller.groups.getAll()

    expect(members).toHaveLength(3)
    expect(groups).toHaveLength(3)
    expect(members.map((member) => member.id)).toContain("mock-member-ada")
    expect(groups.find((group) => group.id === "mock-group-association-members")?.members).toEqual(
      expect.arrayContaining([{ id: "mock-member-ada", displayName: "Ada Lovelace" }])
    )
  })

  it("updates a member number", async () => {
    const caller = await createCaller()

    await expect(caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })).resolves.toEqual({
      error: null,
    })

    const members = await caller.members.getAll()
    expect(members.find((member) => member.id === "mock-member-grace")?.employeeId).toBe("2042")
  })

  it("creates a member and exposes it in later reads", async () => {
    const caller = await createCaller()

    const result = await caller.members.create({
      firstName: "Katherine",
      lastName: "Johnson",
      assocNumber: 2043,
      sendEmailTo: "developer@example.com",
    })

    expect(result).toMatchObject({
      error: null,
      email: "katherine.johnson@polinetwork.org",
      welcomeMailSent: true,
    })
    if (result.error !== null) throw new Error(result.error)
    expect((await caller.members.getAll()).find((member) => member.id === result.id)).toMatchObject({
      displayName: "Katherine Johnson",
      employeeId: "2043",
      isMember: true,
    })
  })

  it("adds and removes group memberships", async () => {
    const caller = await createCaller()
    const input = { groupId: "mock-group-empty", userId: "mock-member-grace" }

    await expect(caller.groups.addMember(input)).resolves.toBe(true)
    expect((await caller.groups.getAll()).find((group) => group.id === input.groupId)?.members).toContainEqual({
      id: input.userId,
      displayName: "Grace Hopper",
    })

    await expect(caller.groups.removeMember(input)).resolves.toBe(true)
    expect((await caller.groups.getAll()).find((group) => group.id === input.groupId)?.members).toEqual([])
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
    await expect(
      caller.members.create({
        firstName: "Katherine",
        lastName: "Johnson",
        assocNumber: 2043,
        sendEmailTo: "test@example.com",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it.each([
    ["no permission", tokenContext([])],
    ["creation alone", tokenContext(["azure:members:create"])],
    ["no admin scope", tokenContext(["azure:members:read"], undefined, [])],
    ["stale snapshot", tokenContext(["azure:members:read"], undefined, undefined, false)],
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

  it("keeps existing-user and group changes unavailable even with both member permissions", async () => {
    const caller = await createCaller(tokenContext(["azure:members:read", "azure:members:create"]))
    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(
      caller.groups.addMember({ groupId: "mock-group-empty", userId: "mock-member-grace" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller.groups.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses anonymous reads when legacy access is disabled", async () => {
    const caller = await createCaller({ legacyAnonymous: "deny" })
    await expect(caller.members.getAll()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
  })
})
