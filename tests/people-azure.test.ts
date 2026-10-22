import { beforeEach, expect, it, vi } from "vitest"
import { newPerson } from "@/people/model"
import { emptyState } from "@/people/types"
import { profile } from "./people-fixtures"

vi.mock("@/azure/config", () => ({ azureCredentials: null }))
vi.mock("@/env", () => ({ env: { NODE_ENV: "test" } }))
vi.mock("@/emails/mailer", () => ({ sendWelcomeEmail: vi.fn().mockResolvedValue(true) }))
vi.mock("@/azure/directory", async () => ({
  azureDirectory: (await import("@/azure/mock-directory")).createMockAzureDirectory(),
}))
beforeEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

it("refuses a People number change held by another Microsoft 365 account", async () => {
  const { setMemberNumber } = await import("@/people/azure-members")
  const person = newPerson(emptyState(), profile(), "2026-10-22")
  person.azureId = "mock-member-alan"
  await expect(setMemberNumber(person, "1001")).rejects.toMatchObject({ code: "CONFLICT" })
  const { azureDirectory } = await import("@/azure/directory")
  expect((await azureDirectory.getMember(person.azureId))?.employeeId).toBe("1002")
})

it("reserves People writes for the legacy Azure workflow while Graph searches lag", async () => {
  const { provisionMember } = await import("@/people/azure-members")
  const { numberHolder } = await import("@/azure/member-writes")
  const { azureDirectory } = await import("@/azure/directory")
  vi.spyOn(azureDirectory, "findByMemberNumber").mockResolvedValue(null)
  const person = newPerson(emptyState(), profile(), "2026-10-22")
  const created = await provisionMember(person, "2042")
  expect(await numberHolder(2042)).toMatchObject({ id: created.id, employeeId: "2042" })
})

it("does not take over an unrelated same-name Microsoft 365 account", async () => {
  const { provisionMember } = await import("@/people/azure-members")
  const person = newPerson(emptyState(), profile("Ada", "Lovelace"), "2026-10-22")
  await expect(provisionMember(person, "1001")).rejects.toMatchObject({ code: "CONFLICT" })
})
