import fontkit from "@pdf-lib/fontkit"
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib"
import type { ArticleChange } from "../contract"
import type { DiffCategory } from "./summarizer"

/**
 * The differences document (spec decision 9a): a first page with the categories, then old and new text side by side
 * only for the articles whose text changed, with word-level highlights; moved and renumbered articles are listed as
 * such. It has no official value. Drawn with pdf-lib in the backend: no LaTeX involved.
 */
export type DifferencesInput = {
  documentTitle: string
  /** e.g. "v2026.10.08" */
  baseLabel: string
  /** e.g. "Bozza «Revisione Team»", or the new tag. */
  newLabel: string
  /** Shown under the title, e.g. "Approvato dal Consiglio Direttivo il 08/10/2026". */
  subtitle: string | null
  categories: DiffCategory[]
  articles: ArticleChange[]
  otherChanges: string[]
  generatedAt: Date
  /** Ubuntu TTFs from the document's assets; Helvetica (WinAnsi only) without them. */
  fonts?: { regular: Uint8Array; bold: Uint8Array } | null
}

const A4 = { width: 595.28, height: 841.89 }
const MARGIN = 48
const COLORS = {
  text: rgb(0.1, 0.1, 0.12),
  muted: rgb(0.42, 0.42, 0.46),
  rule: rgb(0.85, 0.85, 0.87),
  insert: rgb(0.8, 0.94, 0.82),
  remove: rgb(0.98, 0.83, 0.83),
  removeText: rgb(0.55, 0.1, 0.1),
  insertText: rgb(0.05, 0.38, 0.12),
}

type Style = "normal" | "insert" | "delete"
type Token = { text: string; style: Style }
type Line = Token[]

/** Helvetica can only encode WinAnsi: replace what it can't (only used without the Ubuntu fonts). */
function winAnsi(text: string) {
  return text
    .replace(/[⅓]/g, "1/3")
    .replace(/[⅔]/g, "2/3")
    .replace(/[^\x20-\x7e -ÿ–—‘’“”…€\n]/g, "?")
}

export async function renderDifferencesPdf(input: DifferencesInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(`Differenze: ${input.documentTitle}`)
  pdf.setSubject("Documento delle differenze (senza valore ufficiale)")
  pdf.setProducer("PoliNetwork backend")
  pdf.setCreationDate(input.generatedAt)
  let regular: PDFFont
  let bold: PDFFont
  let clean = (s: string) => s
  if (input.fonts) {
    pdf.registerFontkit(fontkit)
    regular = await pdf.embedFont(input.fonts.regular, { subset: false })
    bold = await pdf.embedFont(input.fonts.bold, { subset: false })
  } else {
    regular = await pdf.embedFont(StandardFonts.Helvetica)
    bold = await pdf.embedFont(StandardFonts.HelveticaBold)
    clean = winAnsi
  }

  let page: PDFPage = pdf.addPage([A4.width, A4.height])
  let y = A4.height - MARGIN
  const width = A4.width - 2 * MARGIN
  const newPage = () => {
    page = pdf.addPage([A4.width, A4.height])
    y = A4.height - MARGIN
  }
  const ensure = (height: number) => {
    if (y - height < MARGIN + 20) newPage()
  }

  /** Breaks text into lines of at most `max` points. */
  const wrap = (text: string, font: PDFFont, size: number, max: number): string[] => {
    const out: string[] = []
    for (const paragraph of clean(text).split("\n")) {
      let line = ""
      for (const word of paragraph.split(/(\s+)/)) {
        const candidate = line + word
        if (font.widthOfTextAtSize(candidate, size) <= max || !line.trim()) line = candidate
        else {
          out.push(line.trimEnd())
          line = word.trimStart()
        }
      }
      out.push(line.trimEnd())
    }
    return out
  }
  const paragraph = (
    text: string,
    opts: { font?: PDFFont; size?: number; color?: ReturnType<typeof rgb>; indent?: number; gap?: number } = {}
  ) => {
    const font = opts.font ?? regular
    const size = opts.size ?? 10
    const indent = opts.indent ?? 0
    for (const line of wrap(text, font, size, width - indent)) {
      ensure(size * 1.35)
      page.drawText(line, { x: MARGIN + indent, y: y - size, size, font, color: opts.color ?? COLORS.text })
      y -= size * 1.35
    }
    y -= opts.gap ?? 4
  }
  const rule = () => {
    ensure(10)
    page.drawLine({
      start: { x: MARGIN, y: y - 4 },
      end: { x: A4.width - MARGIN, y: y - 4 },
      thickness: 0.5,
      color: COLORS.rule,
    })
    y -= 12
  }

  // ---- Summary page ----
  paragraph("Documento delle differenze", { font: bold, size: 18, gap: 2 })
  paragraph(input.documentTitle, { font: bold, size: 12, gap: 2 })
  paragraph(`Da ${input.baseLabel} a ${input.newLabel}`, { color: COLORS.muted, gap: 2 })
  if (input.subtitle) paragraph(input.subtitle, { color: COLORS.muted, gap: 2 })
  paragraph(
    "Questo documento evidenzia soltanto le differenze tra le due versioni e non ha valore ufficiale: fa fede il testo emanato.",
    { size: 9, color: COLORS.muted, gap: 8 }
  )
  rule()
  const labelOf = new Map(input.articles.map((a) => [a.id, (a.newLabel ?? a.oldLabel ?? a.id).split(" — ")[0]]))
  if (!input.categories.length && !input.articles.length) paragraph("Nessuna differenza nel testo degli articoli.")
  for (const category of input.categories) {
    ensure(40)
    paragraph(category.title, { font: bold, size: 11, gap: 2 })
    if (category.summary) paragraph(category.summary, { gap: 2 })
    if (category.articleIds.length)
      paragraph(`Articoli: ${category.articleIds.map((id) => labelOf.get(id) ?? id).join(", ")}`, {
        size: 9,
        color: COLORS.muted,
        gap: 8,
      })
  }
  if (input.otherChanges.length) {
    ensure(30)
    paragraph("Altre modifiche", { font: bold, size: 11, gap: 2 })
    for (const change of input.otherChanges) paragraph(`• ${change}`, { size: 9, indent: 6, gap: 1 })
    y -= 6
  }
  const relocated = input.articles.filter((a) => a.kind === "moved" || a.kind === "renumbered")
  if (relocated.length) {
    ensure(30)
    paragraph("Articoli spostati o rinumerati (testo invariato)", { font: bold, size: 11, gap: 2 })
    for (const a of relocated) {
      const from = (a.oldLabel ?? "").split(" — ")[0]
      const to = a.newLabel ?? ""
      paragraph(`• ${from} diventa ${to}${a.kind === "moved" ? " (spostato)" : ""}`, { size: 9, indent: 6, gap: 1 })
    }
  }

  // ---- Side by side, changed articles only ----
  const changed = input.articles.filter((a) => a.kind === "added" || a.kind === "removed" || a.kind === "modified")
  if (changed.length) newPage()
  const gutter = 14
  const column = (width - gutter) / 2
  const size = 9
  const lineHeight = size * 1.45

  const layout = (tokens: Token[]): Line[] => {
    const lines: Line[] = [[]]
    let used = 0
    /** At the start of a source line (keeps the lettere's indent), as opposed to a wrapped one. */
    let fresh = true
    for (const token of tokens) {
      for (const piece of clean(token.text).split(/(\n|[^\S\n]+)/)) {
        if (!piece) continue
        if (piece === "\n") {
          lines.push([])
          used = 0
          fresh = true
          continue
        }
        const w = regular.widthOfTextAtSize(piece, size)
        if (/^\s+$/.test(piece)) {
          if (used === 0 && !fresh) continue
        } else if (used + w > column && used > 0) {
          lines.push([])
          used = 0
        }
        fresh = false
        lines[lines.length - 1].push({ text: piece, style: token.style })
        used += w
      }
    }
    return lines
  }
  const drawLine = (line: Line, x: number, top: number) => {
    let cursor = x
    for (const token of line) {
      const w = regular.widthOfTextAtSize(token.text, size)
      const space = /^\s+$/.test(token.text)
      if (token.style !== "normal" && !space) {
        page.drawRectangle({
          x: cursor - 0.5,
          y: top - size - 2,
          width: w + 1,
          height: size + 3.5,
          color: token.style === "insert" ? COLORS.insert : COLORS.remove,
        })
      }
      page.drawText(token.text, {
        x: cursor,
        y: top - size,
        size,
        font: regular,
        color:
          token.style === "insert" ? COLORS.insertText : token.style === "delete" ? COLORS.removeText : COLORS.text,
      })
      if (token.style === "delete" && !space)
        page.drawLine({
          start: { x: cursor, y: top - size * 0.62 },
          end: { x: cursor + w, y: top - size * 0.62 },
          thickness: 0.6,
          color: COLORS.removeText,
        })
      cursor += w
    }
  }

  for (const article of changed) {
    const left: Token[] =
      article.kind === "added"
        ? []
        : article.kind === "removed"
          ? [{ text: article.oldText ?? "", style: "delete" }]
          : article.words
              .filter((w) => w.op !== "insert")
              .map((w) => ({ text: w.text, style: w.op === "delete" ? "delete" : "normal" }))
    const right: Token[] =
      article.kind === "removed"
        ? []
        : article.kind === "added"
          ? [{ text: article.newText ?? "", style: "insert" }]
          : article.words
              .filter((w) => w.op !== "delete")
              .map((w) => ({ text: w.text, style: w.op === "insert" ? "insert" : "normal" }))
    const leftLines = layout(left)
    const rightLines = layout(right)
    const heading =
      article.kind === "added"
        ? `${article.newLabel} (nuovo)`
        : article.kind === "removed"
          ? `${article.oldLabel} (abrogato)`
          : article.moved
            ? `${article.newLabel} (era ${article.moved.from})`
            : (article.newLabel ?? "")
    ensure(60)
    paragraph(heading, { font: bold, size: 11, gap: 3 })
    const header = (top: number) => {
      page.drawText(clean("Testo vigente"), { x: MARGIN, y: top - 8, size: 8, font: bold, color: COLORS.muted })
      page.drawText(clean("Nuovo testo"), {
        x: MARGIN + column + gutter,
        y: top - 8,
        size: 8,
        font: bold,
        color: COLORS.muted,
      })
    }
    header(y)
    y -= 14
    const rows = Math.max(leftLines.length, rightLines.length)
    for (let i = 0; i < rows; i++) {
      if (y - lineHeight < MARGIN + 20) {
        newPage()
        header(y)
        y -= 14
      }
      if (leftLines[i]) drawLine(leftLines[i], MARGIN, y)
      if (rightLines[i]) drawLine(rightLines[i], MARGIN + column + gutter, y)
      y -= lineHeight
    }
    if (!leftLines.some((l) => l.length))
      page.drawText(clean("—"), { x: MARGIN, y: y + lineHeight - size, size, font: regular, color: COLORS.muted })
    y -= 10
    rule()
  }

  // Footer on every page.
  const pages = pdf.getPages()
  const stamp = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeZone: "Europe/Rome" }).format(
    input.generatedAt
  )
  pages.forEach((p, i) => {
    const text = clean(
      `${input.documentTitle} · differenze senza valore ufficiale · ${stamp} · pagina ${i + 1} di ${pages.length}`
    )
    p.drawText(text, { x: MARGIN, y: MARGIN / 2, size: 7, font: regular, color: COLORS.muted })
  })
  return pdf.save()
}
