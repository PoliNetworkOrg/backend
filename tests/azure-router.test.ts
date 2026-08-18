import { beforeEach, describe, expect, it, vi } from "vitest"

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

async function createCaller() {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value
  for (const key of AZURE_CREDENTIAL_KEYS) delete process.env[key]

  vi.resetModules()
  const { azureRouter } = await import("@/routers/azure")
  return azureRouter.createCaller({})
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
