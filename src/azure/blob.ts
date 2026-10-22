import { DefaultAzureCredential } from "@azure/identity"
import { BlobServiceClient } from "@azure/storage-blob"
import { customAlphabet } from "nanoid"
import { env } from "@/env"
import { logger } from "@/logger"

// Enter your storage account name
const storageAccount = env.AZURE_BLOB_STORAGE_ACCOUNT
const defaultAzureCredential = new DefaultAzureCredential()

export const storageClient = new BlobServiceClient(
  `https://${storageAccount}.blob.core.windows.net`,
  defaultAzureCredential
)

const containerName = env.AZURE_BLOB_STORAGE_CONTAINER
export const containerClient = storageClient.getContainerClient(containerName)

const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz" // default with -_
const nanoid = customAlphabet(alphabet, 21)

export async function uploadBlob(buffer: Buffer, extension: string, mimeType?: string) {
  const filename = `${nanoid()}.${extension.startsWith(".") ? extension.slice(1) : extension}`
  const blobClient = containerClient.getBlockBlobClient(filename)

  const res = await blobClient.upload(buffer, buffer.length, { blobHTTPHeaders: { blobContentType: mimeType } })
  logger.info(`Upload block blob ${filename} successfully with request ID: ${res.requestId}`)
  return { filename, url: `https://${storageAccount}.blob.core.windows.net/${containerName}/${filename}` }
}

export async function deleteBlob(url: string) {
  const filename = new URL(url).pathname.split("/").pop()
  if (!filename) return

  const blobClient = containerClient.getBlockBlobClient(filename)
  const res = await blobClient.deleteIfExists()
  logger.info(`Delete block blob ${filename} successfully: ${res.succeeded}`)
}
