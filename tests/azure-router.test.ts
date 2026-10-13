import type { Actor } from "@polinetwork/auth-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "@/trpc"

const mailer = vi.hoisted(() => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
  sendMemberNumberChangedEmail: vi.fn().mockResolvedValue(true),
}))

vi.mock("@/emails/mailer", () => mailer)

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

/** Widens the gap between the duplicate check and the write, as a slow Graph call would. */
async function slowNumberLookups() {
  const { azureDirectory } = await import("@/azure/directory")
  const find = azureDirectory.findByMemberNumber
  vi.spyOn(azureDirectory, "findByMemberNumber").mockImplementation(async (assocNumber) => {
    const found = await find(assocNumber)
    await new Promise((resolve) => setTimeout(resolve, 20))
    return found
  })
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

  it("creates a member at a custom address", async () => {
    const caller = await createCaller()

    const result = await caller.members.create({
      firstName: "Katherine",
      lastName: "Johnson",
      assocNumber: 2043,
      sendEmailTo: "developer@example.com",
      mailbox: { kind: "custom", localPart: "K.Johnson" },
    })

    expect(result).toMatchObject({ error: null, email: "k.johnson@polinetwork.org" })
  })

  it("builds the standard address without accents, apostrophes or spaces", async () => {
    const caller = await createCaller()

    const result = await caller.members.create({
      firstName: "Maria Chiara",
      lastName: "D'Amicò",
      assocNumber: 2043,
      sendEmailTo: "developer@example.com",
      mailbox: { kind: "standard" },
    })

    expect(result).toMatchObject({ error: null, email: "mariachiara.damico@polinetwork.org" })
  })

  it.each([
    [
      "an address already in use",
      { mailbox: { kind: "custom", localPart: "ada.lovelace" } },
      "The address ada.lovelace@polinetwork.org is already in use.",
    ],
    [
      "a member number already assigned",
      { assocNumber: 1001 },
      "Member number 1001 is already assigned to Ada Lovelace.",
    ],
    [
      "a welcome email to the address being created",
      { sendEmailTo: "Katherine.Johnson@polinetwork.org" },
      "The welcome email cannot go to the address being created: it has no mailbox yet.",
    ],
    [
      "a name without a standard address",
      { firstName: "Łukasz" },
      "This name cannot form a standard address: choose a custom one.",
    ],
  ] as const)("refuses to create a member with %s", async (_, override, error) => {
    const caller = await createCaller()

    const result = await caller.members.create({
      firstName: "Katherine",
      lastName: "Johnson",
      assocNumber: 2043,
      sendEmailTo: "developer@example.com",
      ...override,
    })

    expect(result).toEqual({ error })
    expect(mailer.sendWelcomeEmail).not.toHaveBeenCalled()
  })

  it("lets only one of two concurrent creations take the same number", async () => {
    const caller = await createCaller()
    await slowNumberLookups()
    const member = (firstName: string) => ({
      firstName,
      lastName: "Johnson",
      assocNumber: 2043,
      sendEmailTo: "developer@example.com",
    })

    const results = await Promise.all([
      caller.members.create(member("Katherine")),
      caller.members.create(member("Mary")),
    ])

    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    expect(results.map((result) => result.error)).toContainEqual(
      expect.stringMatching(/^Member number 2043 is already assigned to (Katherine|Mary) Johnson\.$/)
    )
  })

  it("reports an address Entra refuses as already in use", async () => {
    const caller = await createCaller()
    const { azureDirectory } = await import("@/azure/directory")
    vi.spyOn(azureDirectory, "createMember").mockRejectedValueOnce(
      new Error("Another object with the same value for property proxyAddresses already exists.")
    )

    await expect(
      caller.members.create({
        firstName: "Katherine",
        lastName: "Johnson",
        assocNumber: 2043,
        sendEmailTo: "developer@example.com",
      })
    ).resolves.toEqual({ error: "The address katherine.johnson@polinetwork.org is already in use." })
  })

  it("refuses an invalid custom address", async () => {
    const caller = await createCaller()

    await expect(
      caller.members.create({
        firstName: "Katherine",
        lastName: "Johnson",
        assocNumber: 2043,
        sendEmailTo: "developer@example.com",
        mailbox: { kind: "custom", localPart: "k johnson@polinetwork.org" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" })
  })

  it("refuses anonymous member number changes", async () => {
    const caller = await createCaller()

    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" })
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

  it("keeps member number and group changes unavailable with only read and create", async () => {
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

describe("Azure member number changes", () => {
  const writer = () => createCaller(tokenContext(["azure:members:read", "azure:members:write"]))

  it("changes the number and emails the member", async () => {
    const caller = await writer()

    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042, notifyEmail: "alan@example.com" })
    ).resolves.toEqual({ error: null, notificationSent: true })

    expect((await caller.members.getAll()).find((member) => member.id === "mock-member-alan")?.employeeId).toBe("2042")
    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenCalledWith("alan@example.com", {
      firstName: "Alan",
      assocNumber: 2042,
      previousAssocNumber: "1002",
      email: "alan.turing@polinetwork.org",
    })
  })

  it("changes the number without a notification", async () => {
    const caller = await writer()

    await expect(caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })).resolves.toEqual({
      error: null,
      notificationSent: null,
    })
    expect(mailer.sendMemberNumberChangedEmail).not.toHaveBeenCalled()
  })

  it("reports a failed notification after a saved change", async () => {
    mailer.sendMemberNumberChangedEmail.mockResolvedValueOnce(false)
    const caller = await writer()

    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042, notifyEmail: "g@example.com" })
    ).resolves.toEqual({ error: null, notificationSent: false })
    expect((await caller.members.getAll()).find((member) => member.id === "mock-member-grace")?.employeeId).toBe("2042")
  })

  it.each([
    [
      "a number another member holds",
      { userId: "mock-member-grace", assocNumber: 1001 },
      "Member number 1001 is already assigned to Ada Lovelace.",
    ],
    ["the current number", { userId: "mock-member-ada", assocNumber: 1001 }, "The member already has number 1001."],
    [
      "an unknown member",
      { userId: "mock-member-nobody", assocNumber: 2042 },
      "This member no longer exists in the directory.",
    ],
  ])("refuses %s", async (_, input, error) => {
    const caller = await writer()

    await expect(caller.members.setAssocNumber({ ...input, notifyEmail: "x@example.com" })).resolves.toEqual({
      error,
      notificationSent: null,
    })
    expect(mailer.sendMemberNumberChangedEmail).not.toHaveBeenCalled()
  })

  it("lets only one of two concurrent changes take the same number", async () => {
    const caller = await writer()
    await slowNumberLookups()

    const results = await Promise.all([
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 }),
      caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 }),
    ])

    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    const members = await caller.members.getAll()
    expect(members.filter((member) => member.employeeId === "2042")).toHaveLength(1)
  })

  it("refuses a non-positive number", async () => {
    const caller = await writer()
    await expect(caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 0 })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    })
  })

  it.each([
    ["read and create alone", tokenContext(["azure:members:read", "azure:members:create"])],
    ["no admin scope", tokenContext(["azure:members:write"], undefined, [])],
    ["stale snapshot", tokenContext(["azure:members:write"], undefined, undefined, false)],
    ["service actor", tokenContext(["azure:members:write"], { kind: "service", client: "telegram-bot" })],
  ])("refuses changes with %s", async (_, context) => {
    const caller = await createCaller(context)
    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    })
  })
})

describe("Azure group token authorization", () => {
  const membership = { groupId: "mock-group-empty", userId: "mock-member-grace" }

  it("lets group readers list groups but not change memberships", async () => {
    const caller = await createCaller(tokenContext(["azure:groups:read"]))
    expect(await caller.groups.getAll()).not.toHaveLength(0)
    await expect(caller.groups.addMember(membership)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller.groups.removeMember(membership)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("lets group writers add and remove members without reading groups", async () => {
    const caller = await createCaller(tokenContext(["azure:groups:write"]))
    await expect(caller.groups.addMember(membership)).resolves.toBe(true)
    await expect(caller.groups.removeMember(membership)).resolves.toBe(true)
    await expect(caller.groups.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it.each([
    ["no permission", tokenContext([])],
    ["member permissions alone", tokenContext(["azure:members:read", "azure:members:create"])],
    ["no admin scope", tokenContext(["azure:groups:write"], undefined, [])],
    ["stale snapshot", tokenContext(["azure:groups:write"], undefined, undefined, false)],
    ["service actor", tokenContext(["azure:groups:write"], { kind: "service", client: "telegram-bot" })],
  ])("refuses membership changes with %s", async (_, context) => {
    const caller = await createCaller(context)
    await expect(caller.groups.addMember(membership)).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller.groups.removeMember(membership)).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
