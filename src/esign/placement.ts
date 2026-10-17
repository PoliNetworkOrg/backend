import { EsignError } from "./errors"
import type { PlacementJson } from "./store"

export type PlacementInput = PlacementJson

const MIN_SIZE = 0.03

/** Checks a placement against the document and clamps it inside the page. */
export function validatePlacement(p: PlacementInput, pages: number): PlacementJson {
  const finite = [p.page, p.x, p.y, p.width, p.height].every(Number.isFinite)
  if (!finite || !Number.isInteger(p.page) || p.page < 0 || p.page >= pages)
    throw new EsignError("bad_request", "The signature box is outside the document")
  if (p.width < MIN_SIZE || p.height < MIN_SIZE || p.width > 1 || p.height > 1)
    throw new EsignError("bad_request", "The signature box is too small or too large")
  const round = (n: number) => Math.round(n * 1e5) / 1e5
  const x = Math.min(Math.max(p.x, 0), 1 - p.width)
  const y = Math.min(Math.max(p.y, 0), 1 - p.height)
  return { page: p.page, x: round(x), y: round(y), width: round(p.width), height: round(p.height) }
}
