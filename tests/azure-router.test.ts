import type { Actor } from "@polinetwork/auth-kit"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Context } from "@/trpc"

const mailer = vi.hoisted(() => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue(true),
  sendMemberNumberChangedEmail: vi.fn().mockResolvedValue(true),
}))
const logger = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))

vi.mock("@/emails/mailer", () => mailer)
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

/** A dashboard user holding every Azure permission the routers check. */
const ALL_AZURE = ["azure:members:read", "azure:members:create", "azure:groups:read"]

describe("Azure tRPC routes without credentials", () => {
  it("reserves the number of an incomplete account while directory searches are stale", async () => {
    const caller = await createCaller(tokenContext(ALL_AZURE))
    const { azureDirectory } = await import("@/azure/directory")
    const { IncompleteMemberError } = await import("@/azure/errors")
    const create = azureDirectory.createMember
    let creating!: () => void
    const firstCreateStarted = new Promise<void>((resolve) => {
      creating = resolve
    })
    vi.spyOn(azureDirectory, "createMember").mockImplementationOnce(async (input) => {
      creating()
      const member = await create(input)
      throw new IncompleteMemberError(
        {
          id: member.id,
          displayName: "Katherine Johnson",
          givenName: "Katherine",
          mail: member.mail,
          employeeId: "2042",
        },
        new Error("Setup failed")
      )
    })
    vi.spyOn(azureDirectory, "findByMemberNumber").mockResolvedValue(null)
    const input = { firstName: "Katherine", lastName: "Johnson", assocNumber: 2042, sendEmailTo: "test@example.com" }

    // The second request must queue behind the first, whose mock is the one that fails.
    const first = caller.members.create(input)
    await firstCreateStarted
    const second = caller.members.create({ ...input, firstName: "Mary" })
    const results = await Promise.all([first, second])

    expect(results[0]?.error).toContain("setup and cleanup failed")
    expect(results[1]?.error).toContain("Member number 2042 is already assigned")
    expect((await caller.members.getAll()).filter((member) => member.employeeId === "2042")).toHaveLength(1)
    expect(mailer.sendWelcomeEmail).not.toHaveBeenCalled()
  })
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

  it("creates a member and exposes it in later reads", async () => {
    const caller = await createCaller(tokenContext(ALL_AZURE))

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

  it("returns the created member when sending the welcome email throws", async () => {
    mailer.sendWelcomeEmail.mockRejectedValueOnce(new Error("Email rendering failed"))
    const caller = await createCaller(tokenContext(ALL_AZURE))

    const result = await caller.members.create({
      firstName: "Katherine",
      lastName: "Johnson",
      assocNumber: 2043,
      sendEmailTo: "developer@example.com",
    })

    expect(result).toMatchObject({
      error: null,
      email: "katherine.johnson@polinetwork.org",
      welcomeMailSent: false,
    })
    if (result.error !== null) throw new Error(result.error)
    expect((await caller.members.getAll()).find((member) => member.id === result.id)).toMatchObject({
      employeeId: "2043",
      mail: result.email,
    })
  })

  it("creates a member at a custom address", async () => {
    const caller = await createCaller(tokenContext(ALL_AZURE))

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
    const caller = await createCaller(tokenContext(ALL_AZURE))

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
    const caller = await createCaller(tokenContext(ALL_AZURE))

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
    const caller = await createCaller(tokenContext(ALL_AZURE))
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
    const caller = await createCaller(tokenContext(ALL_AZURE))
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
    const caller = await createCaller(tokenContext(ALL_AZURE))

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

  it("keeps existing-user changes and group reads unavailable with only read and create", async () => {
    const caller = await createCaller(tokenContext(["azure:members:read", "azure:members:create"]))
    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })
    ).rejects.toMatchObject({ code: "FORBIDDEN" })
    await expect(caller.groups.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })

  it("refuses anonymous reads unless LEGACY_ANONYMOUS allows them", async () => {
    for (const context of [{}, { legacyAnonymous: "deny" } as const]) {
      const caller = await createCaller(context)
      await expect(caller.members.getAll()).rejects.toMatchObject({ code: "UNAUTHORIZED" })
    }
    expect(await (await createCaller({ legacyAnonymous: "allow" })).members.getAll()).toHaveLength(3)
  })
})

describe("Azure member number changes", () => {
  const writer = () => createCaller(tokenContext(["azure:members:read", "azure:members:write"]))

  it("uses a different external number even before the previous write has been observed", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    const before = await azureDirectory.getMember("mock-member-alan")
    const read = vi.spyOn(azureDirectory, "getMember").mockResolvedValue(before)
    await caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 })
    read.mockRestore()
    await azureDirectory.setMemberNumber("mock-member-alan", 2043)

    await caller.members.setAssocNumber({
      userId: "mock-member-alan",
      assocNumber: 2044,
      notifyEmail: "alan@example.com",
    })

    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenCalledWith(
      "alan@example.com",
      expect.objectContaining({ previousAssocNumber: "2043", assocNumber: 2044 })
    )
  })

  it("refuses to change an existing user deleted before a saved write was observed", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    await caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 })
    vi.spyOn(azureDirectory, "getMember").mockResolvedValue(null)
    const write = vi.spyOn(azureDirectory, "setMemberNumber")

    await expect(caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2043 })).resolves.toEqual({
      error: "This member no longer exists in the directory.",
      notificationSent: null,
    })
    expect(write).not.toHaveBeenCalled()
  })

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

  it("redacts personal email addresses from directory error logs", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    vi.spyOn(azureDirectory, "setMemberNumber").mockResolvedValue({
      error: 'Graph conflict for "personal@example.com"',
    })

    await caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 })

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Graph conflict for "[redacted email]"' }),
      "[trpc:azure:members] could not set the member number"
    )
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain("personal@example.com")
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

  it("keeps a saved number change successful when sending its notification throws", async () => {
    mailer.sendMemberNumberChangedEmail.mockRejectedValueOnce(new Error("Email rendering failed"))
    const caller = await writer()

    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042, notifyEmail: "g@example.com" })
    ).resolves.toEqual({ error: null, notificationSent: false })
    expect((await caller.members.getAll()).find((member) => member.id === "mock-member-grace")?.employeeId).toBe("2042")
  })

  it.each([
    "changes",
    "creations",
    "create then change",
    "change then create",
  ] as const)("allows only one claimant during concurrent %s while number lookups are stale", async (scenario) => {
    const caller = await createCaller(
      tokenContext(["azure:members:read", "azure:members:write", "azure:members:create"])
    )
    const { azureDirectory } = await import("@/azure/directory")
    vi.spyOn(azureDirectory, "findByMemberNumber").mockResolvedValue(null)
    const create = (firstName: string) =>
      caller.members.create({
        firstName,
        lastName: "Johnson",
        assocNumber: 2042,
        sendEmailTo: "developer@example.com",
      })
    const change = (userId: string) => caller.members.setAssocNumber({ userId, assocNumber: 2042 })
    const operations = {
      changes: () => [change("mock-member-grace"), change("mock-member-alan")],
      creations: () => [create("Katherine"), create("Mary")],
      "create then change": () => [create("Katherine"), change("mock-member-grace")],
      "change then create": () => [change("mock-member-grace"), create("Katherine")],
    }

    const results = await Promise.all(operations[scenario]())

    expect(results.filter((result) => result.error === null)).toHaveLength(1)
    expect(results.map((result) => result.error)).toContainEqual(
      expect.stringMatching(/^Member number 2042 is already assigned to /)
    )
    expect((await caller.members.getAll()).filter((member) => member.employeeId === "2042")).toHaveLength(1)
  })

  it("keeps the latest number reserved across successive writes while the member read still shows the original number", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    const originalMember = await azureDirectory.getMember("mock-member-alan")
    const currentGet = azureDirectory.getMember
    vi.spyOn(azureDirectory, "getMember").mockImplementation((userId) =>
      userId === "mock-member-alan" ? Promise.resolve(originalMember) : currentGet(userId)
    )
    vi.spyOn(azureDirectory, "findByMemberNumber").mockResolvedValue(null)

    for (const assocNumber of [2042, 2043]) {
      await expect(
        caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber, notifyEmail: "alan@example.com" })
      ).resolves.toEqual({ error: null, notificationSent: true })
    }
    await expect(caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2043 })).resolves.toEqual({
      error: "Member number 2043 is already assigned to Alan Turing.",
      notificationSent: null,
    })
    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2043, notifyEmail: "alan@example.com" })
    ).resolves.toEqual({ error: "The member already has number 2043.", notificationSent: null })

    expect((await caller.members.getAll()).filter((member) => member.employeeId === "2043")).toHaveLength(1)
    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenCalledTimes(2)
    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenLastCalledWith(
      "alan@example.com",
      expect.objectContaining({ assocNumber: 2043, previousAssocNumber: "2042" })
    )
  })

  it("does not repeat a saved change or its email while the member read is stale", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    const originalMember = await azureDirectory.getMember("mock-member-alan")
    vi.spyOn(azureDirectory, "getMember").mockResolvedValue(originalMember)
    const write = vi.spyOn(azureDirectory, "setMemberNumber")
    const input = { userId: "mock-member-alan", assocNumber: 2042, notifyEmail: "alan@example.com" }

    await expect(caller.members.setAssocNumber(input)).resolves.toEqual({ error: null, notificationSent: true })
    await expect(caller.members.setAssocNumber(input)).resolves.toEqual({
      error: "The member already has number 2042.",
      notificationSent: null,
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenCalledTimes(1)
    expect((await caller.members.getAll()).find((member) => member.id === input.userId)?.employeeId).toBe("2042")
  })

  it("does not repeat a change when number lookup confirms it before the member read does", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    const originalMember = await azureDirectory.getMember("mock-member-alan")
    const currentGet = azureDirectory.getMember
    vi.spyOn(azureDirectory, "getMember").mockImplementation((userId) =>
      userId === "mock-member-alan" ? Promise.resolve(originalMember) : currentGet(userId)
    )
    const write = vi.spyOn(azureDirectory, "setMemberNumber")
    const input = { userId: "mock-member-alan", assocNumber: 2042, notifyEmail: "alan@example.com" }

    await expect(caller.members.setAssocNumber(input)).resolves.toEqual({ error: null, notificationSent: true })
    await expect(caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })).resolves.toEqual({
      error: "Member number 2042 is already assigned to Alan Turing.",
      notificationSent: null,
    })
    await expect(caller.members.setAssocNumber(input)).resolves.toEqual({
      error: "The member already has number 2042.",
      notificationSent: null,
    })

    expect(write).toHaveBeenCalledTimes(1)
    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenCalledTimes(1)
    expect((await caller.members.getAll()).find((member) => member.id === input.userId)?.employeeId).toBe("2042")
  })

  it("uses a subsequent external number change after the member read has confirmed a saved change", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    vi.spyOn(azureDirectory, "findByMemberNumber").mockResolvedValue(null)

    await expect(caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 })).resolves.toEqual({
      error: null,
      notificationSent: null,
    })
    await expect(caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 })).resolves.toEqual({
      error: "The member already has number 2042.",
      notificationSent: null,
    })
    await azureDirectory.setMemberNumber("mock-member-alan", 2043)
    await expect(
      caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2044, notifyEmail: "alan@example.com" })
    ).resolves.toEqual({ error: null, notificationSent: true })

    expect(mailer.sendMemberNumberChangedEmail).toHaveBeenCalledWith("alan@example.com", {
      firstName: "Alan",
      assocNumber: 2044,
      previousAssocNumber: "2043",
      email: "alan.turing@polinetwork.org",
    })
    expect((await caller.members.getAll()).find((member) => member.id === "mock-member-alan")?.employeeId).toBe("2044")
  })

  it("allows a released number to be reassigned after the previous holder changes it again", async () => {
    const caller = await writer()
    const { azureDirectory } = await import("@/azure/directory")
    const currentFind = azureDirectory.findByMemberNumber
    const lookup = vi.spyOn(azureDirectory, "findByMemberNumber").mockResolvedValue(null)

    await expect(caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2042 })).resolves.toEqual({
      error: null,
      notificationSent: null,
    })
    await expect(caller.members.setAssocNumber({ userId: "mock-member-alan", assocNumber: 2043 })).resolves.toEqual({
      error: null,
      notificationSent: null,
    })
    lookup.mockImplementation(currentFind)
    await expect(caller.members.setAssocNumber({ userId: "mock-member-grace", assocNumber: 2042 })).resolves.toEqual({
      error: null,
      notificationSent: null,
    })

    const members = await caller.members.getAll()
    expect(members.find((member) => member.id === "mock-member-alan")?.employeeId).toBe("2043")
    expect(members.find((member) => member.id === "mock-member-grace")?.employeeId).toBe("2042")
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
  it("lets group readers list groups", async () => {
    const caller = await createCaller(tokenContext(["azure:groups:read"]))
    expect(await caller.groups.getAll()).not.toHaveLength(0)
  })

  it.each([
    ["no permission", tokenContext([])],
    ["member permissions alone", tokenContext(["azure:members:read", "azure:members:create"])],
    ["no admin scope", tokenContext(["azure:groups:read"], undefined, [])],
    ["service actor", tokenContext(["azure:groups:read"], { kind: "service", client: "telegram-bot" })],
  ])("refuses listing groups with %s", async (_, context) => {
    const caller = await createCaller(context)
    await expect(caller.groups.getAll()).rejects.toMatchObject({ code: "FORBIDDEN" })
  })
})
