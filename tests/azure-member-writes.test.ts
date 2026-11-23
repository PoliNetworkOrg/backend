import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MemberSummary } from "@/azure/types"

vi.mock("@/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

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

/** Fresh modules, so each test gets its own mock directory, lock and pending-number cache. */
async function load() {
  for (const [key, value] of Object.entries(REQUIRED_ENV)) process.env[key] = value
  for (const key of AZURE_CREDENTIAL_KEYS) delete process.env[key]
  vi.resetModules()
  const { azureDirectory } = await import("@/azure/directory")
  const writes = await import("@/azure/member-writes")
  return { directory: azureDirectory, ...writes }
}

type Loaded = Awaited<ReturnType<typeof load>>

/** A number change as `soci.members.setNumber` makes it: read the account, write Entra, remember the number. */
async function change({ directory, currentMember, rememberNumber }: Loaded, userId: string, number: number) {
  const member = (await currentMember(userId)) as MemberSummary
  await directory.setMemberNumber(userId, number)
  rememberNumber(member, number)
}

/** Answers user reads of `userId` with what the account looked like before any write, as a lagging Graph would. */
async function staleReadsOf({ directory }: Loaded, userId: string) {
  const before = await directory.getMember(userId)
  const read = directory.getMember
  return vi
    .spyOn(directory, "getMember")
    .mockImplementation((id) => (id === userId ? Promise.resolve(before) : read(id)))
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe("Microsoft 365 member writes", () => {
  it("runs writes one at a time, so only one of two concurrent claims takes a number", async () => {
    const loaded = await load()
    const { directory, serializeMemberWrite, numberHolder } = loaded
    // Entra's number search lags behind writes.
    vi.spyOn(directory, "findByMemberNumber").mockResolvedValue(null)
    const claim = (userId: string) =>
      serializeMemberWrite(async () => {
        if (await numberHolder(2042)) return false
        await new Promise((resolve) => setTimeout(resolve, 10))
        await change(loaded, userId, 2042)
        return true
      })

    const results = await Promise.all([claim("mock-member-grace"), claim("mock-member-alan")])

    expect(results.filter(Boolean)).toHaveLength(1)
    expect((await directory.getMembers()).filter((m) => m.employeeId === "2042")).toHaveLength(1)
  })

  it("keeps running writes after one fails", async () => {
    const { serializeMemberWrite } = await load()
    const failed = serializeMemberWrite(() => Promise.reject(new Error("Graph down")))
    await expect(failed).rejects.toThrow("Graph down")
    await expect(serializeMemberWrite(async () => "next")).resolves.toBe("next")
  })

  it("reserves the number of an incomplete account while the number search can't see it", async () => {
    const { directory, rememberNumber, numberHolder } = await load()
    vi.spyOn(directory, "findByMemberNumber").mockResolvedValue(null)
    const incomplete = {
      id: "created-katherine",
      displayName: "Katherine Johnson",
      givenName: "Katherine",
      mail: "katherine.johnson@polinetwork.org",
      employeeId: "2042",
    }

    rememberNumber(incomplete, 2042, true)

    // The account isn't readable yet either: a new account, so that doesn't release the number.
    expect(await numberHolder(2042)).toMatchObject({ id: "created-katherine", employeeId: "2042" })
  })

  it("shows a saved number while user reads still show the old one", async () => {
    const loaded = await load()
    const { directory, currentMember, numberHolder } = loaded
    await staleReadsOf(loaded, "mock-member-alan")
    vi.spyOn(directory, "findByMemberNumber").mockResolvedValue(null)

    await change(loaded, "mock-member-alan", 2042)

    expect((await currentMember("mock-member-alan"))?.employeeId).toBe("2042")
    expect((await numberHolder(2042))?.id).toBe("mock-member-alan")
  })

  it("keeps the latest of successive numbers, and frees the one in between", async () => {
    const loaded = await load()
    const { directory, currentMember, numberHolder } = loaded
    await staleReadsOf(loaded, "mock-member-alan")
    vi.spyOn(directory, "findByMemberNumber").mockResolvedValue(null)

    await change(loaded, "mock-member-alan", 2042)
    await change(loaded, "mock-member-alan", 2043)

    expect((await currentMember("mock-member-alan"))?.employeeId).toBe("2043")
    expect((await numberHolder(2043))?.id).toBe("mock-member-alan")
    expect(await numberHolder(2042)).toBeNull()
  })

  it("frees a number once its holder has moved on, when the number search catches up", async () => {
    const loaded = await load()
    const { directory, numberHolder } = loaded
    const search = vi.spyOn(directory, "findByMemberNumber").mockResolvedValue(null)

    await change(loaded, "mock-member-alan", 2042)
    await change(loaded, "mock-member-alan", 2043)
    search.mockRestore()

    expect(await numberHolder(2042)).toBeNull()
    expect((await numberHolder(2043))?.id).toBe("mock-member-alan")
  })

  it("treats an existing account deleted before its write was seen as gone", async () => {
    const loaded = await load()
    const { directory, currentMember } = loaded

    await change(loaded, "mock-member-alan", 2042)
    vi.spyOn(directory, "getMember").mockResolvedValue(null)

    expect(await currentMember("mock-member-alan")).toBeNull()
  })

  it("follows a change made outside the backend, before or after its own write was seen", async () => {
    for (const seenFirst of [false, true]) {
      const loaded = await load()
      const { directory, currentMember, numberHolder } = loaded
      const stale = await staleReadsOf(loaded, "mock-member-alan")

      await change(loaded, "mock-member-alan", 2042)
      stale.mockRestore()
      if (seenFirst) expect((await currentMember("mock-member-alan"))?.employeeId).toBe("2042")
      await directory.setMemberNumber("mock-member-alan", 2043)

      expect((await currentMember("mock-member-alan"))?.employeeId, `seen first: ${seenFirst}`).toBe("2043")
      expect(await numberHolder(2042), `seen first: ${seenFirst}`).toBeNull()
    }
  })
})

describe("safeErrorDetail", () => {
  it("redacts email addresses from what is logged", async () => {
    const { safeErrorDetail } = await import("@/azure/errors")
    const detail = safeErrorDetail(new Error('Graph conflict for "personal@example.com"'))
    expect(detail).toContain('Graph conflict for "[redacted email]"')
    expect(detail).not.toContain("personal@example.com")
    expect(safeErrorDetail({ to: "first.last+tag@sub.example.it" })).toBe('{"to":"[redacted email]"}')
  })
})
