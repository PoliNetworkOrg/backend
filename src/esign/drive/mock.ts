import { randomUUID } from "node:crypto"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { type Drive, DriveError, type DriveItem, isPdfName } from "./types"

type Node = { id: string; name: string; parentId: string | null; bytes: Uint8Array | null; modifiedAt: string }

async function samplePdf(title: string, lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  doc.setTitle(title)
  const font = await doc.embedFont(StandardFonts.TimesRoman)
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold)
  const page = doc.addPage([595.28, 841.89])
  page.drawText("PoliNetwork APS", { x: 60, y: 780, size: 12, font: bold })
  page.drawText(title, { x: 60, y: 740, size: 18, font: bold })
  lines.forEach((line, i) => {
    page.drawText(line, { x: 60, y: 700 - i * 18, size: 12, font })
  })
  page.drawText("Il Segretario", { x: 70, y: 170, size: 12, font })
  page.drawText("Il Presidente", { x: 380, y: 170, size: 12, font })
  const second = doc.addPage([595.28, 841.89])
  second.drawText("Allegato A", { x: 60, y: 780, size: 14, font: bold })
  return doc.save({ useObjectStreams: true })
}

/**
 * A seeded in-memory drive for development without Microsoft 365 credentials. Its contents last until the backend
 * restarts.
 */
export function createMockDrive(options = { id: "dev", label: "OneDrive (development copy)" }): Drive {
  const nodes = new Map<string, Node>()
  const now = () => new Date().toISOString()
  const add = (name: string, parentId: string | null, bytes: Uint8Array | null = null, id: string = randomUUID()) => {
    const node = { id, name, parentId, bytes, modifiedAt: now() }
    nodes.set(id, node)
    return node
  }
  const root = add("Documenti PoliNetwork", null, null, "mock-root")
  const verbali = add("Verbali", root.id, null, "mock-verbali")
  add("Contratti", root.id, null, "mock-contratti")
  add("Firmati", root.id, null, "mock-firmati")
  const seeded = (async () => {
    add(
      "Verbale Consiglio Direttivo 2026-10-10.pdf",
      verbali.id,
      await samplePdf("Verbale della riunione del Consiglio Direttivo", [
        "Il giorno 10 ottobre 2026 si e' riunito il Consiglio Direttivo.",
        "Ordine del giorno:",
        "1. Approvazione del bilancio",
        "2. Nuove iniziative per le matricole",
        "Il Consiglio approva all'unanimita'.",
      ]),
      "mock-verbale-cd"
    )
    add(
      "Verbale Assemblea Soci 2026-09-30.pdf",
      verbali.id,
      await samplePdf("Verbale dell'Assemblea dei Soci", ["L'Assemblea si e' riunita in seconda convocazione."]),
      "mock-verbale-assemblea"
    )
  })()

  const toItem = (n: Node): DriveItem => ({
    id: n.id,
    name: n.name,
    kind: n.bytes ? "pdf" : "folder",
    size: n.bytes?.length ?? null,
    modifiedAt: n.modifiedAt,
    webUrl: null,
  })
  const pathOf = (n: Node): string => {
    const parts: string[] = []
    for (let c: Node | undefined = n; c && c.id !== root.id; c = c.parentId ? nodes.get(c.parentId) : undefined)
      parts.unshift(c.name)
    return parts.join("/")
  }
  const folderNode = (id: string) => {
    const n = nodes.get(id)
    if (!n || n.bytes) throw new DriveError("not_found", "Folder not found")
    return n
  }

  return {
    id: options.id,
    label: options.label,
    async list(folderId = root.id) {
      await seeded
      const folder = folderNode(folderId)
      const items = [...nodes.values()]
        .filter((n) => n.parentId === folder.id && (!n.bytes || isPdfName(n.name)))
        .map(toItem)
        .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1))
      return {
        folder: { id: folder.id, name: folder.name, parentId: folder.parentId, isRoot: folder.id === root.id },
        path: pathOf(folder),
        items,
      }
    },
    async download(itemId) {
      await seeded
      const n = nodes.get(itemId)
      if (!n?.bytes) throw new DriveError("not_found", "File not found")
      return { item: toItem(n), bytes: n.bytes }
    },
    async upload(folderId, fileName, bytes) {
      const folder = folderNode(folderId)
      const taken = new Set([...nodes.values()].filter((n) => n.parentId === folder.id).map((n) => n.name))
      let name = fileName
      for (let i = 1; taken.has(name); i++) name = fileName.replace(/(\.pdf)?$/i, ` ${i}$1`)
      return toItem(add(name, folder.id, bytes))
    },
    async folder(folderId) {
      const n = nodes.get(folderId)
      return n && !n.bytes ? { id: n.id, path: pathOf(n) } : null
    },
  }
}
