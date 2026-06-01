import { DefaultAzureCredential } from "@azure/identity"
import { BlobServiceClient } from "@azure/storage-blob"
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

export async function uploadBlob(buffer: Buffer, extension: string) {
  const filename = `upload_${Date.now()}.${extension}`
  const blobClient = containerClient.getBlockBlobClient(filename)

  const res = await blobClient.upload(buffer, buffer.length)
  logger.info(`Upload block blob ${filename} successfully with request ID: ${res.requestId}`)
  return { filename, url: `https://${storageAccount}.blob.core.windows.net/${containerName}/${filename}` }
}
