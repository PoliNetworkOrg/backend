import { randomUUID } from "node:crypto"
import { generatePassword } from "@/utils/password"
import { MAIL_DOMAIN } from "./mailbox"
import type { AzureDirectory, MemberSummary, ParsedGroup, ParsedUser } from "./types"

type MockUser = ParsedUser & { createdDateTime: string }

const ASSOCIATION_GROUP_ID = "mock-group-association-members"

const SEEDED_MEMBERS: MockUser[] = [
  {
    id: "mock-member-ada",
    displayName: "Ada Lovelace",
    mail: "ada.lovelace@polinetwork.org",
    givenName: "Ada",
    surname: "Lovelace",
    employeeId: "1001",
    isMember: true,
    assignedLicensesIds: ["OFFICE_365", "POWER_AUTOMATE"],
    createdDateTime: "2024-10-02T09:00:00Z",
  },
  {
    id: "mock-member-alan",
    displayName: "Alan Turing",
    mail: "alan.turing@polinetwork.org",
    givenName: "Alan",
    surname: "Turing",
    employeeId: "1002",
    isMember: true,
    assignedLicensesIds: ["OFFICE_365"],
    createdDateTime: "2025-03-14T15:30:00Z",
  },
  {
    id: "mock-member-grace",
    displayName: "Grace Hopper",
    mail: "grace.hopper@polinetwork.org",
    givenName: "Grace",
    surname: "Hopper",
    employeeId: null,
    isMember: false,
    assignedLicensesIds: [],
    createdDateTime: "2025-09-01T08:00:00Z",
  },
]

const SEEDED_GROUPS: ParsedGroup[] = [
  {
    id: ASSOCIATION_GROUP_ID,
    displayName: "Local association members",
    mailAddress: "local-members@polinetwork.org",
    members: [
      { id: "mock-member-ada", displayName: "Ada Lovelace" },
      { id: "mock-member-alan", displayName: "Alan Turing" },
    ],
  },
  {
    id: "mock-group-volunteers",
    displayName: "Local volunteers",
    mailAddress: null,
    members: [{ id: "mock-member-grace", displayName: "Grace Hopper" }],
  },
  {
    id: "mock-group-empty",
    displayName: "Local empty group",
    mailAddress: "local-empty@polinetwork.org",
    members: [],
  },
]

function cloneMembers(members: MockUser[]): MockUser[] {
  return members.map((member) => ({ ...member, assignedLicensesIds: [...member.assignedLicensesIds] }))
}

function parsed({ createdDateTime: _, ...member }: MockUser): ParsedUser {
  return { ...member, assignedLicensesIds: [...member.assignedLicensesIds] }
}

function summary({ id, displayName, givenName, mail, employeeId }: ParsedUser): MemberSummary {
  return { id, displayName, givenName, mail, employeeId }
}

function cloneGroups(groups: ParsedGroup[]): ParsedGroup[] {
  return groups.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member })) }))
}

export function createMockAzureDirectory(): AzureDirectory {
  const members = cloneMembers(SEEDED_MEMBERS)
  const groups = cloneGroups(SEEDED_GROUPS)
  const sociGroup = () => groups.find((group) => group.id === ASSOCIATION_GROUP_ID) as ParsedGroup

  return {
    async getMembers() {
      return members.map(parsed)
    },

    async getMember(userId) {
      const member = members.find((candidate) => candidate.id === userId)
      return member ? summary(member) : null
    },

    async findByMemberNumber(assocNumber) {
      const member = members.find((candidate) => candidate.employeeId === assocNumber.toString())
      return member ? summary(member) : null
    },

    async findByMail(mail) {
      const member = members.find((candidate) => candidate.mail === mail)
      return member ? summary(member) : null
    },

    async setMemberNumber(userId, assocNumber) {
      const member = members.find((candidate) => candidate.id === userId)
      if (!member) return { error: `Azure member ${userId} was not found in the local directory` }

      member.employeeId = assocNumber.toString()
      return { error: null }
    },

    async createMember({ firstName, lastName, assocNumber, localPart }) {
      const mail = `${localPart}@${MAIL_DOMAIN}`
      if (members.some((member) => member.mail === mail)) {
        throw new Error(`Azure member ${mail} already exists in the local directory`)
      }

      const id = `mock-member-${randomUUID()}`
      const displayName = `${firstName} ${lastName}`
      members.push({
        id,
        displayName,
        mail,
        givenName: firstName,
        surname: lastName,
        employeeId: assocNumber.toString(),
        isMember: true,
        assignedLicensesIds: ["OFFICE_365", "POWER_AUTOMATE"],
        createdDateTime: new Date().toISOString(),
      })
      sociGroup().members.push({ id, displayName })

      return { firstName, lastName, id, mail, password: generatePassword() }
    },

    async getAllGroups() {
      return cloneGroups(groups)
    },

    async getSociMembers() {
      return members
        .filter((member) => member.isMember)
        .map((member) => ({ ...summary(member), surname: member.surname, createdDateTime: member.createdDateTime }))
    },

    async addToSoci(userId) {
      const member = members.find((candidate) => candidate.id === userId)
      if (!member) throw new Error(`Azure member ${userId} was not found in the local directory`)
      if (member.isMember) return
      member.isMember = true
      sociGroup().members.push({ id: member.id, displayName: member.displayName ?? "" })
    },

    async removeFromSoci(userId) {
      const member = members.find((candidate) => candidate.id === userId)
      if (member) member.isMember = false
      const group = sociGroup()
      group.members = group.members.filter((candidate) => candidate.id !== userId)
    },

    async deleteUser(userId) {
      const index = members.findIndex((candidate) => candidate.id === userId)
      if (index >= 0) members.splice(index, 1)
      for (const group of groups) group.members = group.members.filter((candidate) => candidate.id !== userId)
    },
  }
}
