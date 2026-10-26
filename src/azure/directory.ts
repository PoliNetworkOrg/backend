import { logger } from "@/logger"
import { azureCredentials } from "./config"
import { addGroupMember, getAllGroups, removeGroupMember } from "./functions/groups"
import {
  createMember,
  findByMail,
  findByMemberNumber,
  getMember,
  getMembers,
  setMemberNumber,
} from "./functions/members"
import { createMockAzureDirectory } from "./mock-directory"
import type { AzureDirectory } from "./types"

const graphAzureDirectory: AzureDirectory = {
  getMembers,
  getMember,
  findByMemberNumber,
  findByMail,
  setMemberNumber,
  createMember,
  getAllGroups,
  addGroupMember,
  removeGroupMember,
}

export const azureDirectory: AzureDirectory = azureCredentials ? graphAzureDirectory : createMockAzureDirectory()

if (!azureCredentials) {
  logger.warn("Azure credentials are not set, using the seeded in-memory directory")
}
