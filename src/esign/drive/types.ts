export type DriveItem = {
  id: string
  name: string
  kind: "folder" | "pdf"
  size: number | null
  modifiedAt: string | null
  webUrl: string | null
}

export type DriveListing = {
  folder: { id: string; name: string; parentId: string | null; isRoot: boolean }
  /** Path below the configured root, e.g. "Verbali/2026"; "" at the root. */
  path: string
  items: DriveItem[]
}

/** The association's document library (a OneDrive or SharePoint drive), restricted to one root folder. */
export interface Drive {
  /** Shown in the dashboard, e.g. "OneDrive · Segreteria". */
  readonly label: string
  list(folderId?: string): Promise<DriveListing>
  download(itemId: string): Promise<{ item: DriveItem; bytes: Uint8Array }>
  /** Uploads into a folder; an existing name gets a numbered suffix instead of being overwritten. */
  upload(folderId: string, fileName: string, bytes: Uint8Array): Promise<DriveItem>
  /** The folder and its path below the root, or null when it is outside the root or missing. */
  folder(folderId: string): Promise<{ id: string; path: string } | null>
}

export class DriveError extends Error {
  constructor(
    readonly code: "not_found" | "outside_root" | "not_pdf" | "too_large" | "unavailable",
    message: string
  ) {
    super(message)
    this.name = "DriveError"
  }
}

/** PDFs larger than this are refused: they would not fit the database or an email comfortably. */
export const MAX_PDF_BYTES = 30 * 1024 * 1024

export function isPdfName(name: string) {
  return name.toLowerCase().endsWith(".pdf")
}
