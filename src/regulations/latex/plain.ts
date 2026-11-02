import { type DocumentNode, letterOf, type ParsedDocument, refLabel } from "./document"

/**
 * Plain text of LaTeX in the allowed inline subset, for diffs, the LLM and the differences PDF. Cross-references
 * read as their current number ("articolo 2.3 comma 4"); other commands keep only their text.
 */
export function renderInline(latex: string, doc: ParsedDocument | null): string {
  let s = latex.replace(/(^|[^\\])%[^\n]*/g, "$1")
  s = s.replace(/\\rif\s*\{([^}]*)\}/g, (_, id: string) => (doc ? (refLabel(doc, id.trim()) ?? "[?]") : `[${id}]`))
  s = s.replace(/\\href\s*\{[^}]*\}\s*\{([^}]*)\}/g, "$1")
  s = s.replace(/\\footnote\s*\{([^}]*)\}/g, " ($1)")
  s = s.replace(/\\begin\{elenco\}|\\end\{elenco\}|\\begin\{itemize\}|\\end\{itemize\}/g, "")
  s = s.replace(/\\(voce|item)\b\s*/g, "\n• ")
  s = s.replace(/\\\\(\[[^\]]*\])?/g, "\n")
  s = s.replace(/\\(ldots|dots)\b\s?/g, "…")
  s = s.replace(/\\([&%$#_{}])/g, "$1")
  s = s.replace(/---/g, "—").replace(/--/g, "–")
  s = s.replace(/``/g, "“").replace(/''/g, "”")
  s = s.replace(/~/g, " ")
  // Any other command: drop its name (and an optional argument), keep the text of its arguments.
  s = s.replace(/\\[a-zA-Z@]+\*?\s*(\[[^\]]*\])?/g, "")
  s = s.replace(/[{}]/g, "")
  return s
    .split("\n")
    .map((line) => line.replace(/[ \t\r]+/g, " ").trim())
    .filter((line, i, all) => line || (i > 0 && all[i - 1]))
    .join("\n")
    .trim()
}

/** A node's own LaTeX, after its heading (`\articolo[…]{…}`, `\comma[…]`), up to its first child. */
function ownText(doc: ParsedDocument, node: DocumentNode, until?: number): string {
  const text = doc.files.get(node.file)?.text ?? ""
  return text.slice(node.parsed.headerEnd, until ?? node.parsed.end)
}

function renderLettere(doc: ParsedDocument, node: DocumentNode, indent: string): string[] {
  const lines: string[] = []
  node.children.forEach((child, k) => {
    if (child.kind !== "lettera") return
    const nested = child.children.filter((c) => c.kind === "lettera")
    const body = ownText(doc, child, nested[0]?.range.start).replace(/\\(begin|end)\{lettere\}/g, "")
    lines.push(`${indent}${letterOf(k + 1)}) ${renderInline(body, doc)}`)
    if (nested.length) lines.push(...renderLettere(doc, child, `${indent}   `))
  })
  return lines
}

/** An article as plain text: its body, then one numbered paragraph per comma with its lettere. */
export function articleText(doc: ParsedDocument, article: DocumentNode): string {
  const lines: string[] = []
  const first = article.children[0]
  const intro = ownText(doc, article, first?.range.start).replace(/\\(begin|end)\{(commi|lettere)\}/g, "")
  const rendered = renderInline(intro, doc)
  if (rendered) lines.push(rendered)
  for (const child of article.children) {
    if (child.kind === "comma") {
      const lettere = child.children.filter((c) => c.kind === "lettera")
      const body = ownText(doc, child, lettere[0]?.range.start).replace(/\\(begin|end)\{(commi|lettere)\}/g, "")
      lines.push(`${child.number}. ${renderInline(body, doc)}`)
      if (lettere.length) {
        lines.push(...renderLettere(doc, child, "   "))
        const after = (doc.files.get(child.file)?.text ?? "")
          .slice(lettere[lettere.length - 1].range.end, child.range.end)
          .replace(/\\(begin|end)\{(commi|lettere)\}/g, "")
        const tail = renderInline(after, doc)
        if (tail) lines.push(`   ${tail}`)
      }
    }
  }
  if (article.children.some((c) => c.kind === "lettera")) lines.push(...renderLettere(doc, article, "   "))
  return lines.join("\n")
}
