import { beforeEach, describe, expect, it, vi } from "vitest"

const graph = vi.hoisted(() => ({ getAzureClient: vi.fn() }))
const PASSWORD = "private-generated-password"

vi.mock("@/azure/client", () => graph)
vi.mock("@/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), error: vi.fn() } }))
vi.mock("@/utils/password", () => ({ generatePassword: () => "private-generated-password" }))
vi.mock("@/utils/wait", () => ({ withRetry: (task: () => Promise<unknown>) => task() }))

import { createMember, findByMemberNumber, getMembers } from "@/azure/functions/members"

const SOCI_ID = "1c68dbb8-4ac3-4569-a886-283b5a825cbd"
const CREATED_ID = "created-katherine"
const CREATED_MAIL = "katherine.johnson@polinetwork.org"
const NEW_MEMBER = { firstName: "Katherine", lastName: "Johnson", assocNumber: 2042, localPart: "katherine.johnson" }

type GraphUser = {
  id: string
  displayName: string
  mail: string
  givenName: string
  surname: string
  employeeId: string
  assignedLicenses: { skuId: string }[]
}

function user(id: string, employeeId: string): GraphUser {
  return {
    id,
    displayName: id,
    mail: `${id}@polinetwork.org`,
    givenName: id,
    surname: "Member",
    employeeId,
    assignedLicenses: [],
  }
}

function fakeGraph(
  options: { failGroup?: boolean; failLicenses?: boolean; failCleanup?: boolean; cleanupNotFound?: boolean } = {}
) {
  const users = new Map<string, GraphUser>([["existing-user", user("existing-user", "1001")]])
  const soci = new Set<string>(["existing-user"])
  const deleted = new Set<string>()
  const userPageTwo = "https://graph.microsoft.com/v1.0/users?$skiptoken=users-page-two"
  const groupPageTwo = `https://graph.microsoft.com/v1.0/groups/${SOCI_ID}/members?$skiptoken=group-page-two`
  let pages = false

  const client = {
    api(resource: string) {
      const url = new URL(resource, "https://graph.microsoft.com/v1.0/")
      const path = url.pathname.replace(/^\/v1\.0/, "")
      let advanced = false
      let filter = ""
      const request = {
        header(name: string, value: string) {
          if (name === "ConsistencyLevel" && value === "eventual") advanced = true
          return request
        },
        count(enabled: boolean) {
          if (enabled) advanced = true
          return request
        },
        select() {
          return request
        },
        filter(value: string) {
          filter = value
          return request
        },
        top() {
          return request
        },
        async get() {
          if (path === "/users" && filter.startsWith("employeeId eq ")) {
            const employeeId = filter.match(/^employeeId eq '([^']+)'$/)?.[1]
            return { value: advanced ? [] : [...users.values()].filter((member) => member.employeeId === employeeId) }
          }
          if (path === "/users") {
            if (pages) {
              if (url.searchParams.has("$skiptoken") && !advanced) throw new Error("Advanced query header missing")
              return url.searchParams.has("$skiptoken")
                ? { value: [user("second-page-user", "2043")] }
                : { value: [users.get("existing-user")], "@odata.nextLink": userPageTwo }
            }
            return { value: [...users.values()] }
          }
          if (path === `/groups/${SOCI_ID}/members`) {
            if (pages) {
              return url.searchParams.has("$skiptoken")
                ? { value: [{ id: "existing-user" }, { id: "second-page-user" }] }
                : { value: [{ id: "unlisted-user" }], "@odata.nextLink": groupPageTwo }
            }
            return { value: [...soci].map((id) => ({ id })) }
          }
          if (path.startsWith("/users/")) return users.get(path.slice("/users/".length))
          throw new Error(`Unexpected Graph read: ${resource}`)
        },
        async post(body: Record<string, unknown>) {
          if (path === "/users") {
            users.set(CREATED_ID, {
              ...user(CREATED_ID, typeof body.employeeId === "string" ? body.employeeId : ""),
              displayName: String(body.displayName),
              mail: String(body.userPrincipalName),
            })
            return { id: CREATED_ID }
          }
          if (path === `/groups/${SOCI_ID}/members/$ref`) {
            if (options.failGroup) throw new Error("Group membership unavailable")
            const id = String(body["@odata.id"]).split("/").at(-1)
            if (id) soci.add(id)
            return undefined
          }
          if (path === `/users/${CREATED_ID}/assignLicense`) {
            if (options.failLicenses) throw new Error("License assignment unavailable")
            return undefined
          }
          throw new Error(`Unexpected Graph write: ${resource}`)
        },
        async patch(body: Partial<GraphUser>) {
          const id = path.slice("/users/".length)
          const member = users.get(id)
          if (!member) throw new Error("User does not exist")
          users.set(id, { ...member, ...body })
        },
        async delete() {
          if (options.failCleanup) throw new Error("Cleanup unavailable")
          const id = path.slice("/users/".length)
          users.delete(id)
          soci.delete(id)
          deleted.add(id)
          if (options.cleanupNotFound) throw Object.assign(new Error("User no longer exists"), { statusCode: 404 })
        },
      }
      return request
    },
  }
  graph.getAzureClient.mockReturnValue(client)
  return {
    users,
    soci,
    deleted,
    paginate() {
      pages = true
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("Azure member directory Graph operations", () => {
  it("includes subsequent user and Soci membership pages", async () => {
    const directory = fakeGraph()
    directory.paginate()

    const members = await getMembers()

    expect(members.map((member) => member.id)).toEqual(["existing-user", "second-page-user"])
    expect(members.every((member) => member.isMember)).toBe(true)
  })

  it.each([
    ["group membership", { failGroup: true }, "Group membership unavailable"],
    ["license assignment", { failLicenses: true }, "License assignment unavailable"],
  ])("removes only the newly created account when %s fails", async (_, failure, error) => {
    const directory = fakeGraph(failure)

    await expect(createMember(NEW_MEMBER)).rejects.toThrow(error)

    expect([...directory.users.keys()]).toEqual(["existing-user"])
    expect([...directory.soci]).toEqual(["existing-user"])
    expect([...directory.deleted]).toEqual([CREATED_ID])
  })

  it("treats an already absent account as successful cleanup and preserves the provisioning error", async () => {
    const directory = fakeGraph({ failGroup: true, cleanupNotFound: true })

    await expect(createMember(NEW_MEMBER)).rejects.toThrow("Group membership unavailable")

    expect([...directory.users.keys()]).toEqual(["existing-user"])
    expect([...directory.soci]).toEqual(["existing-user"])
    expect([...directory.deleted]).toEqual([CREATED_ID])
  })

  it("identifies an incomplete account without exposing its password when cleanup also fails", async () => {
    const directory = fakeGraph({ failGroup: true, failCleanup: true })
    const result = await createMember(NEW_MEMBER).then(
      () => ({ message: "Unexpected success" }),
      (error: Error) => error
    )

    expect(result.message).toContain(CREATED_ID)
    expect(result.message).toContain(CREATED_MAIL)
    expect(result.message).not.toContain(PASSWORD)
    expect(directory.users.get(CREATED_ID)?.mail).toBe(CREATED_MAIL)
    expect(directory.users.has("existing-user")).toBe(true)
    expect(directory.deleted.size).toBe(0)
  })

  it("finds the current number holder even while the advanced query index is stale", async () => {
    const directory = fakeGraph()
    directory.users.set("fresh-number-holder", user("fresh-number-holder", "2042"))

    await expect(findByMemberNumber(2042)).resolves.toMatchObject({
      id: "fresh-number-holder",
      employeeId: "2042",
    })
  })
})
