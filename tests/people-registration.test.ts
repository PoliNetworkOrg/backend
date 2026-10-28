import assert from "node:assert/strict"
import { describe, expect, it, vi } from "vitest"
import {
  type CreateAuthPerson,
  type LinkAuthPerson,
  type PeopleRoles,
  RoleChangeError,
  type RoleDirectory,
  type UnlinkAuthPerson,
} from "@/people/roles"
import { SOURCE_TTL_MS } from "@/people/service"
import { harness, master, viewer } from "./people-fixtures"

function authPeople() {
  const directory: RoleDirectory = {
    roles: [
      { key: "admin", name: "Admin", binding: "admin" },
      { key: "it", name: "IT", binding: "team:it:member" },
    ],
    users: [],
  }
  const roles: PeopleRoles = {
    directory: vi.fn(async () => structuredClone(directory)),
    change: vi.fn(async () => ({ roles: directory.roles, held: [], assigned: [] })),
    create: vi.fn(async (input: CreateAuthPerson) => {
      const sub = `people:${input.id}`
      if (!directory.users.some((user) => user.sub === sub))
        directory.users.push({
          sub,
          registrationId: sub,
          provisional: true,
          name: `${input.firstName} ${input.lastName}`,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.email || null,
          phone: input.phone || null,
          telegramId: null,
          declaredTelegramId: input.telegramId || null,
          declaredTelegramUsername: input.telegramUsername || null,
          telegramUsername: null,
          roles: input.changes.flatMap((change) => (change.kind === "admin" ? ["admin"] : [change.team])),
        })
      return { sub }
    }),
    link: vi.fn(async (input: LinkAuthPerson) => {
      if (input.actor !== "president") throw new RoleChangeError(403, "Master Admin required")
      const person = directory.users.find((person) => person.registrationId === input.personId)
      if (!person) throw new Error("Person not found")
      // Auth reports the linked registration through the login account, as one user.
      const login = directory.users.find((user) => user.sub === input.userId)
      directory.users = directory.users.filter((user) => user !== login)
      Object.assign(person, { previousSub: person.sub, sub: input.userId, provisional: false })
      person.verifiedEmail = login?.verifiedEmail ?? null
      return { sub: input.userId }
    }),
    unlink: vi.fn(async (input: UnlinkAuthPerson) => {
      if (input.actor !== "president") throw new RoleChangeError(403, "Master Admin required")
      const person = directory.users.find((person) => person.registrationId === input.personId)
      if (!person) throw new Error("Person not found")
      // The login account is listed on its own again, without the person's roles.
      directory.users.push({ ...person, registrationId: undefined, previousSub: undefined, roles: [] })
      Object.assign(person, { sub: input.personId, provisional: true, previousSub: undefined, verifiedEmail: null })
      return { sub: input.personId }
    }),
  }
  return { directory, roles }
}

describe("People before the first Auth login", () => {
  it("creates with names and roles only in Auth, and keeps blank census data", async () => {
    const auth = authPeople()
    const h = harness({ peopleRoles: auth.roles, allowLocalPeople: false })
    const input = {
      requestId: "7b3c7576-3f7d-4ef8-9765-82e00cf0a04e",
      firstName: "Mario",
      lastName: "Rossi",
      teams: ["it" as const],
      admin: true,
    }
    const created = await h.service.createPerson(master, input)
    expect(await h.service.createPerson(master, input)).toEqual(created)
    const person = await h.service.getPerson(master, created)
    expect(person).toMatchObject({
      preliminary: true,
      profile: { firstName: "Mario", lastName: "Rossi", course: "", year: "", campus: null, personalEmail: null },
      admin: { status: "active" },
      teams: [{ team: "it", role: "member" }],
      account: { status: "none" },
    })
    expect(await h.service.listPeople(master)).toHaveLength(1)
    expect(auth.roles.create).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: master.sub,
        changes: [
          { kind: "admin", active: true },
          { kind: "team", team: "it", role: "member" },
        ],
      })
    )
  })

  it("requires Master approval and retains the register identity and roles after linking", async () => {
    const auth = authPeople()
    const h = harness({ peopleRoles: auth.roles, allowLocalPeople: false })
    const created = await h.service.createPerson(master, {
      firstName: "Mario",
      lastName: "Rossi",
      personalEmail: "new@example.org",
      teams: ["it"],
      admin: true,
    })
    const registration = auth.directory.users[0]
    assert.ok(registration.registrationId)
    auth.directory.users.push({
      sub: "new-login",
      name: "Mario Rossi",
      email: "new@example.org",
      verifiedEmail: "new@example.org",
      telegramId: null,
      telegramUsername: null,
      roles: [],
    })
    h.advance(SOURCE_TTL_MS.directory + 1)
    // The person signing in learns they were found, and isn't sent to ask to be added.
    const self = viewer("new-login", ["people:self"])
    expect(await h.service.getMyArea(self)).toEqual({
      state: "awaiting-approval",
      candidate: { id: created.id, name: "Mario Rossi", roles: ["Admin", "IT"] },
      reason: expect.stringContaining("A Master Admin will confirm the link"),
    })
    await expect(h.service.askToBeAdded(self, { note: "" } as never)).rejects.toThrow("already checking")
    // The verified match is the only review: the same name doesn't add a name-only one.
    const reviews = await h.service.listReviews(master)
    expect(reviews.map((r) => r.kind)).toEqual(["preliminary-link"])
    const [review] = reviews
    expect(review).toMatchObject({ kind: "preliminary-link", record: { id: created.id } })
    expect(await h.service.getMyRoles(viewer("new-login", ["people:self"]))).toEqual({ capoScope: null, leads: [] })
    const input = {
      reviewId: review.id,
      resolution: "link-anyway",
      reason: "Verified the email belongs to this person",
    }
    await expect(h.service.resolveReview(viewer("vice", ["admin:access", "people:write"]), input)).rejects.toThrow(
      "Master Admin required"
    )
    expect((await h.service.getPerson(master, created)).account.status).toBe("none")
    await h.service.resolveReview(master, input)
    expect(await h.service.getPerson(master, created)).toMatchObject({
      preliminary: false,
      account: { status: "linked" },
      admin: { status: "active" },
      teams: [{ team: "it", role: "member" }],
    })
    expect(await h.service.listPeople(master)).toHaveLength(1)
    expect(await h.service.listReviews(master)).toEqual([])

    // The link shows among recent ones; undoing it needs a Master Admin and gives the roles back to the person.
    expect(await h.service.listRecentLinks(master)).toEqual([
      expect.objectContaining({ personId: created.id, preliminary: true, linkedBy: "admin" }),
    ])
    await expect(
      h.service.unlinkAccount(viewer("vice", ["admin:access", "people:write"]), { personId: created.id })
    ).rejects.toThrow("Master Admin required")
    await h.service.unlinkAccount(master, { personId: created.id })
    expect(auth.roles.unlink).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "unlink-person", personId: registration.registrationId })
    )
    h.advance(SOURCE_TTL_MS.directory + 1)
    expect(await h.service.getPerson(master, created)).toMatchObject({
      preliminary: true,
      account: { status: "none" },
      admin: { status: "active" },
      teams: [{ team: "it", role: "member" }],
    })
    expect(await h.service.listPeople(master)).toHaveLength(1)
    expect(await h.service.listRecentLinks(master)).toEqual([])
    // The same account isn't proposed this person again.
    expect(await h.service.getMyArea(self)).toMatchObject({ state: "none" })
    expect(await h.service.listReviews(master)).toEqual([])
  })

  it("recovers a confirmed Auth link without creating a duplicate after a backend restart", async () => {
    const auth = authPeople()
    const h = harness({ peopleRoles: auth.roles, allowLocalPeople: false })
    const created = await h.service.createPerson(master, { firstName: "Mario", lastName: "Rossi", admin: true })
    const registration = auth.directory.users[0]
    registration.previousSub = registration.sub
    registration.sub = "first-login"
    registration.provisional = false
    h.advance(SOURCE_TTL_MS.directory + 1)
    const restarted = harness({ peopleRoles: auth.roles, store: h.store, allowLocalPeople: false })
    expect(await restarted.service.listPeople(master)).toHaveLength(1)
    expect(await restarted.service.getPerson(master, created)).toMatchObject({
      preliminary: false,
      account: { status: "linked" },
      admin: { status: "active" },
    })
  })

  it("does not auto-claim a preliminary person from a declared Telegram contact", async () => {
    const auth = authPeople()
    const h = harness({ peopleRoles: auth.roles, allowLocalPeople: false })
    const created = await h.service.createPerson(master, {
      firstName: "Mario",
      lastName: "Rossi",
      telegramId: "123",
      admin: true,
    })
    auth.directory.users.push({
      sub: "different-login",
      name: "Mario Rossi",
      email: null,
      telegramId: "123",
      telegramUsername: null,
      roles: ["admin"],
    })
    h.advance(SOURCE_TTL_MS.directory + 1)
    // The role holder's Telegram account matches the declared contact: a Master Admin decides, and no second
    // record is made meanwhile.
    expect(await h.service.listPeople(master)).toHaveLength(1)
    expect(await h.service.getPerson(master, created)).toMatchObject({ preliminary: true, account: { status: "none" } })
    expect(await h.service.listReviews(master)).toEqual([
      expect.objectContaining({ kind: "preliminary-link", record: expect.objectContaining({ id: created.id }) }),
    ])
    expect(auth.roles.link).not.toHaveBeenCalled()
  })

  it("tells a weaker match it is being checked without showing the record", async () => {
    const auth = authPeople()
    const h = harness({ peopleRoles: auth.roles, allowLocalPeople: false })
    await h.service.createPerson(master, { firstName: "Anna", lastName: "Bianchi", telegramUsername: "anna_pn" })
    const registration = auth.directory.users[0]
    assert.ok(registration.registrationId)
    auth.directory.users.push({
      sub: "tg-login",
      name: "Someone",
      email: null,
      verifiedEmail: null,
      telegramId: "77",
      telegramUsername: "Anna_PN",
      roles: [],
    })
    h.advance(SOURCE_TTL_MS.directory + 1)
    expect(await h.service.getMyArea(viewer("tg-login", ["people:self"]))).toEqual({
      state: "awaiting-approval",
      candidate: null,
      reason: expect.stringContaining("You don't need to ask to be added"),
    })
    const [review] = await h.service.listReviews(master)
    expect(review).toMatchObject({ kind: "preliminary-link", message: expect.stringContaining("Usernames can change") })
  })

  it("fails without Auth instead of creating a local authority", async () => {
    const h = harness({ allowLocalPeople: false })
    await expect(
      h.service.createPerson(master, { firstName: "Mario", lastName: "Rossi", admin: true })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" })
    expect(await h.service.listPeople(master)).toEqual([])
  })
})
