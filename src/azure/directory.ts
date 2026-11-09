import { logger } from "@/logger"
import { azureCredentials } from "./config"
import { getAllGroups } from "./functions/groups"
import {
  addToSoci,
  createMember,
  deleteUser,
  findByMail,
  findByMemberNumber,
  getMember,
  getMembers,
  getSociMembers,
  removeFromSoci,
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
  getSociMembers,
  addToSoci,
  removeFromSoci,
  deleteUser,
}

export const azureDirectory: AzureDirectory = azureCredentials ? graphAzureDirectory : createMockAzureDirectory()

if (!azureCredentials) {
  logger.warn("Azure credentials are not set, using the seeded in-memory directory")
}
