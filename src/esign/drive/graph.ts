import { type Client, ResponseType } from "@microsoft/microsoft-graph-client"
import type { DriveItem as GraphDriveItem } from "@microsoft/microsoft-graph-types"
import { type Drive, DriveError, type DriveItem, isPdfName, MAX_PDF_BYTES } from "./types"

const SELECT = "id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference"

/** "/drives/{id}/root:/A/B" and "/drive/root:/A/B" → "/A/B". */
function normalize(path: string | null | undefined): string {
  return (path ?? "").replace(/^\/drives?\/(?:[^/]+\/)?root:/, "")
}

function fullPath(item: GraphDriveItem): string {
  if (!item.parentReference?.path) return "" // the drive root
  return `${normalize(item.parentReference.path)}/${item.name}`
}

function toItem(item: GraphDriveItem): DriveItem {
  return {
    id: item.id ?? "",
    name: item.name ?? "",
    kind: item.folder ? "folder" : "pdf",
    size: item.size ?? null,
    modifiedAt: item.lastModifiedDateTime ?? null,
    webUrl: item.webUrl ?? null,
  }
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404
}

/**
 * A Microsoft Graph drive (OneDrive or SharePoint library) below `rootId`. Needs the application permission
 * Files.ReadWrite.All (or Sites.Selected with write access to the site).
 */
export function createGraphDrive(options: {
  client: () => Client
  id: string
  driveId: string
  rootId: string
  label: string
}): Drive {
  const base = `/drives/${encodeURIComponent(options.driveId)}`

  const getItem = async (id: string): Promise<GraphDriveItem> => {
    try {
      return await options
        .client()
        .api(`${base}/items/${encodeURIComponent(id)}`)
        .select(SELECT)
        .get()
    } catch (error) {
      if (isNotFound(error)) throw new DriveError("not_found", "Item not found")
      throw error
    }
  }
  /** The root's current path, read on every check: a cached path would outlive a rename or move of the root. */
  const root = async () => fullPath(await getItem(options.rootId))
  /** The item's path below the root, or null when it is elsewhere in the drive. */
  const relative = async (item: GraphDriveItem): Promise<string | null> => {
    const rp = await root()
    const p = fullPath(item)
    if (p === rp) return ""
    return p.startsWith(`${rp}/`) ? p.slice(rp.length + 1) : null
  }
  const inside = async (id: string) => {
    const item = await getItem(id)
    const path = await relative(item)
    if (path === null) throw new DriveError("outside_root", "This item is outside the shared folder")
    return { item, path }
  }

  return {
    id: options.id,
    label: options.label,
    async list(folderId = options.rootId) {
      const { item: folder, path } = await inside(folderId)
      if (!folder.folder) throw new DriveError("not_found", "Not a folder")
      const items: DriveItem[] = []
      let next: string | undefined =
        `${base}/items/${encodeURIComponent(folder.id ?? folderId)}/children?$select=${SELECT}&$top=200`
      while (next && items.length < 1000) {
        const page: { value: GraphDriveItem[]; "@odata.nextLink"?: string } = await options.client().api(next).get()
        for (const child of page.value)
          if (child.folder || (child.file && isPdfName(child.name ?? ""))) items.push(toItem(child))
        next = page["@odata.nextLink"]
      }
      items.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1))
      const isRoot = path === ""
      return {
        folder: {
          id: folder.id ?? folderId,
          name: folder.name ?? "",
          parentId: isRoot ? null : (folder.parentReference?.id ?? null),
          isRoot,
        },
        path,
        items,
      }
    },
    async download(itemId) {
      const { item } = await inside(itemId)
      if (!item.file || !isPdfName(item.name ?? "")) throw new DriveError("not_pdf", "Only PDF files can be signed")
      if ((item.size ?? 0) > MAX_PDF_BYTES) throw new DriveError("too_large", "The PDF is larger than 30 MB")
      const data: ArrayBuffer = await options
        .client()
        .api(`${base}/items/${encodeURIComponent(itemId)}/content`)
        .responseType(ResponseType.ARRAYBUFFER)
        .get()
      return { item: toItem(item), bytes: new Uint8Array(data) }
    },
    async upload(folderId, fileName, bytes) {
      const { item: folder } = await inside(folderId)
      if (!folder.folder) throw new DriveError("not_found", "Not a folder")
      const created: GraphDriveItem = await options
        .client()
        .api(
          `${base}/items/${encodeURIComponent(folder.id ?? folderId)}:/${encodeURIComponent(fileName)}:/content?@microsoft.graph.conflictBehavior=rename`
        )
        .header("Content-Type", "application/pdf")
        .put(Buffer.from(bytes))
      return toItem(created)
    },
    async folder(folderId) {
      try {
        const { item, path } = await inside(folderId)
        return item.folder ? { id: item.id ?? folderId, path } : null
      } catch (error) {
        if (error instanceof DriveError) return null
        throw error
      }
    },
  }
}
