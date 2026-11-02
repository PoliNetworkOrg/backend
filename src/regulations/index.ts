import { eq } from "drizzle-orm"
import { DB } from "@/db"
import { blobs, versions } from "@/db/schema/regulations"
import { env } from "@/env"
import { idp } from "@/idp"
import { logger } from "@/logger"
import { createCollabControl } from "./collab/internal-client"
import { createWorkerClient } from "./compile/client"
import { type AssetBundle, sourceHash } from "./compile/protocol"
import { sha256 } from "./db"
import { createDirectory } from "./directory"
import { localLegalSource } from "./legal-source"
import { createRegulationsService } from "./service"

export const regulationsDirectory = createDirectory(idp?.directory ?? null)

const worker = env.REGULATIONS_WORKER_URL
  ? createWorkerClient({
      url: env.REGULATIONS_WORKER_URL,
      secret: env.REGULATIONS_WORKER_SECRET,
      async loadAssets(hash) {
        const [blob] = await DB.select().from(blobs).where(eq(blobs.hash, hash))
        if (!blob) throw new Error(`asset bundle ${hash} not found`)
        return JSON.parse(Buffer.from(blob.content).toString("utf8")) as AssetBundle
      },
    })
  : null

const collab =
  env.REGULATIONS_COLLAB_INTERNAL_URL && env.REGULATIONS_INTERNAL_SECRET
    ? createCollabControl({ url: env.REGULATIONS_COLLAB_INTERNAL_URL, secret: env.REGULATIONS_INTERNAL_SECRET })
    : null
if (!collab) logger.warn("[REGULATIONS] The collab service is not configured: drafts can't be edited live")

export const regulations = createRegulationsService({
  db: DB,
  directory: regulationsDirectory,
  collab,
  collabUrl: env.REGULATIONS_COLLAB_PUBLIC_URL ?? null,
  legal: env.REGULATIONS_LEGAL_DIR ? localLegalSource(env.REGULATIONS_LEGAL_DIR) : null,
  compileVersion: worker
    ? async (version) => {
        const hash = await sourceHash({ entry: version.entry, files: version.files, assets: version.assets })
        const response = await worker.compile({ key: `version:${version.id}`, hash, ...version })
        if (response.status !== "done" || !response.ok || !response.pdf) return null
        const content = new Uint8Array(Buffer.from(response.pdf, "base64"))
        const blobHash = sha256(content)
        await DB.insert(blobs).values({ hash: blobHash, contentType: "application/pdf", content }).onConflictDoNothing()
        await DB.update(versions).set({ pdfBlob: blobHash }).where(eq(versions.id, version.id))
        return content
      }
    : undefined,
})
