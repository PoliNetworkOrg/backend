import type { PDFPage } from "pdf-lib"

/**
 * Where a signature goes, as the signer saw the page: fractions of the displayed page (crop box, after /Rotate) with
 * the origin at the top-left corner.
 */
export type Placement = {
  /** Zero-based page index. */
  page: number
  x: number
  y: number
  width: number
  height: number
}

export type PageRect = {
  /** The widget rectangle in user space, `[llx lly urx ury]`. */
  rect: [number, number, number, number]
  rotation: 0 | 90 | 180 | 270
  /** Size of the box as displayed, which is the appearance stream's BBox. */
  width: number
  height: number
}

/** The page rotation, normalized to 0, 90, 180 or 270. */
export function pageRotation(page: PDFPage): PageRect["rotation"] {
  const angle = (((page.getRotation().angle % 360) + 360) % 360) as number
  return angle === 90 || angle === 180 || angle === 270 ? angle : 0
}

/** Displayed page size in points. */
export function displayedSize(page: PDFPage): { width: number; height: number } {
  const crop = page.getCropBox()
  const rotation = pageRotation(page)
  return rotation === 90 || rotation === 270
    ? { width: crop.height, height: crop.width }
    : { width: crop.width, height: crop.height }
}

/** Maps a displayed-page placement to user space. */
export function rectOnPage(page: PDFPage, placement: Placement): PageRect {
  const crop = page.getCropBox()
  const rotation = pageRotation(page)
  const shown = displayedSize(page)
  const clamp = (n: number) => Math.min(1, Math.max(0, n))
  const u0 = clamp(placement.x) * shown.width
  const v0 = clamp(placement.y) * shown.height
  const u1 = clamp(placement.x + placement.width) * shown.width
  const v1 = clamp(placement.y + placement.height) * shown.height
  const x0 = crop.x
  const y0 = crop.y
  const x1 = crop.x + crop.width
  const y1 = crop.y + crop.height
  // (u, v): displayed coordinates from the top-left corner.
  const toUser = (u: number, v: number): [number, number] => {
    switch (rotation) {
      case 90:
        return [x0 + v, y0 + u]
      case 180:
        return [x1 - u, y0 + v]
      case 270:
        return [x1 - v, y1 - u]
      default:
        return [x0 + u, y1 - v]
    }
  }
  const [ax, ay] = toUser(u0, v0)
  const [bx, by] = toUser(u1, v1)
  return {
    rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
    rotation,
    width: u1 - u0,
    height: v1 - v0,
  }
}
