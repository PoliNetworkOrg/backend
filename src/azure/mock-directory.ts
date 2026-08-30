import { randomUUID } from "node:crypto"
import { generatePassword } from "@/utils/password"
import type { AzureDirectory, ParsedGroup, ParsedUser } from "./types"

const ASSOCIATION_GROUP_ID = "mock-group-association-members"

const SEEDED_MEMBERS: ParsedUser[] = [
  {
    id: "mock-member-ada",
    displayName: "Ada Lovelace",
    mail: "ada.lovelace@polinetwork.org",
    givenName: "Ada",
    surname: "Lovelace",
    employeeId: "1001",
    isMember: true,
    assignedLicensesIds: ["OFFICE_365", "POWER_AUTOMATE"],
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

function cloneMembers(members: ParsedUser[]): ParsedUser[] {
  return members.map((member) => ({ ...member, assignedLicensesIds: [...member.assignedLicensesIds] }))
}

function cloneGroups(groups: ParsedGroup[]): ParsedGroup[] {
  return groups.map((group) => ({ ...group, members: group.members.map((member) => ({ ...member })) }))
}

export function createMockAzureDirectory(): AzureDirectory {
  const members = cloneMembers(SEEDED_MEMBERS)
  const groups = cloneGroups(SEEDED_GROUPS)

  return {
    async getMembers() {
      return cloneMembers(members)
    },

    async setMemberNumber(userId, assocNumber) {
      const member = members.find((candidate) => candidate.id === userId)
      if (!member) return { error: `Azure member ${userId} was not found in the local directory` }

      member.employeeId = assocNumber.toString()
      return { error: null }
    },

    async createMember({ firstName, lastName, assocNumber }) {
      const mailNickname = `${firstName.replaceAll(" ", "")}.${lastName.replaceAll(" ", "")}`.toLowerCase()
      const mail = `${mailNickname}@polinetwork.org`
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
      })
      groups.find((group) => group.id === ASSOCIATION_GROUP_ID)?.members.push({ id, displayName })

      return { firstName, lastName, id, mail, password: generatePassword() }
    },

    async getAllGroups() {
      return cloneGroups(groups)
    },

    async addGroupMember(groupId, userId) {
      const group = groups.find((candidate) => candidate.id === groupId)
      const member = members.find((candidate) => candidate.id === userId)
      if (!group || !member || group.members.some((candidate) => candidate.id === userId)) return false

      group.members.push({ id: member.id, displayName: member.displayName ?? member.mail ?? "Unnamed member" })
      if (group.id === ASSOCIATION_GROUP_ID) member.isMember = true
      return true
    },

    async removeGroupMember(groupId, userId) {
      const group = groups.find((candidate) => candidate.id === groupId)
      const memberIndex = group?.members.findIndex((candidate) => candidate.id === userId) ?? -1
      if (!group || memberIndex === -1) return false

      group.members.splice(memberIndex, 1)
      if (group.id === ASSOCIATION_GROUP_ID) {
        const member = members.find((candidate) => candidate.id === userId)
        if (member) member.isMember = false
      }
      return true
    },
  }
}
