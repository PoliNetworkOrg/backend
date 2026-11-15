import type { ValidationIssue } from "../contract"

/**
 * Parser of the regulations grammar (legal repository, `docs/grammar.md`):
 *
 *   \regolamento[id=…]{Titolo}
 *   \begin{capo}[id=…]{Titolo} … \end{capo}             (optional grouping, nestable)
 *   \articolo[id=…]{Titolo}                               (unnumbered body text, or commi)
 *   \begin{commi} \comma[id=…] … \end{commi}
 *   \begin{lettere} \lettera … \end{lettere}              (inside a comma, or an article's body)
 *   \rif{<id>}                                            (cross-reference by stable id)
 *
 * Everything else is kept as opaque text of the node it falls in. The parser never fails: problems become issues with
 * positions, and the text may be invalid while people type. Offsets are UTF-16 code units (CodeMirror, Y.Text).
 */

export type ParsedKind = "file" | "regolamento" | "capo" | "articolo" | "comma" | "lettera"

export type ParsedNode = {
  kind: ParsedKind
  /** The `id=` value, or `null` when missing (lettere are positional and never carry one). */
  id: string | null
  /** Where the id value is, to rewrite a duplicate. */
  idRange: { start: number; end: number } | null
  /** The `[…]` optional argument, brackets included. */
  optRange: { start: number; end: number } | null
  /** Offset right after the macro name, where `[id=…]` is inserted when there is no optional argument. */
  macroEnd: number
  title: string | null
  start: number
  /** After the command and its arguments: where the node's own text begins. */
  headerEnd: number
  end: number
  children: ParsedNode[]
}

export type FileParse = {
  path: string
  text: string
  root: ParsedNode
  issues: ValidationIssue[]
  /** `\input`/`\include` targets, normalized relative to the document directory, in order, with the node they are in. */
  inputs: { path: string; offset: number; parent: ParsedNode }[]
  /** `\rif{…}` occurrences. */
  refs: { id: string; start: number; end: number }[]
}

/** Lowercase base36, 6 chars. */
export const ID_PATTERN = /^[0-9a-z]{6}$/

const STRUCTURAL = new Set(["regolamento", "articolo"])
/** Inline commands allowed in the text of articles, commi and lettere (spec: allowed inline subset). */
const INLINE_ALLOWED = new Set([
  "textbf",
  "emph",
  "textit",
  "underline",
  "href",
  "url",
  "footnote",
  "enquote",
  "rif",
  "ldots",
  "dots",
  "newline",
  "textquotedblleft",
  "textquotedblright",
  "S",
  "voce",
  "texttt",
])

type Frame =
  | { type: "node"; node: ParsedNode; envDepth: number }
  | {
      type: "env"
      name: string
      kind: "commi" | "lettere" | "capo" | "generic"
      owner: ParsedNode | null
      offset: number
    }

function lineIndex(text: string) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return (offset: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 }
  }
}

const isLetter = (c: number) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 64 /* @ */

export function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return parts.join("/")
}

/** Reads a balanced `open … close` group starting at `i` (which must be `open`); returns the index after it. */
function readGroup(text: string, i: number, open: string, close: string): { content: string; end: number } | null {
  if (text[i] !== open) return null
  let depth = 0
  let braces = 0
  for (let j = i; j < text.length; j++) {
    const ch = text[j]
    if (ch === "\\") {
      j++
      continue
    }
    if (ch === "%") {
      const nl = text.indexOf("\n", j)
      if (nl < 0) return null
      j = nl
      continue
    }
    if (open === "[") {
      if (ch === "{") braces++
      else if (ch === "}") braces--
      else if (braces === 0 && ch === "[") depth++
      else if (braces === 0 && ch === "]") {
        depth--
        if (depth === 0) return { content: text.slice(i + 1, j), end: j + 1 }
      }
    } else if (ch === open) depth++
    else if (ch === close) {
      depth--
      if (depth === 0) return { content: text.slice(i + 1, j), end: j + 1 }
    }
  }
  return null
}

/** Skips spaces and at most one newline (LaTeX lets arguments follow on the next line, not after a blank line). */
function skipArgSpace(text: string, i: number): number {
  let newlines = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === " " || ch === "\t" || ch === "\r") i++
    else if (ch === "\n" && newlines === 0) {
      newlines++
      i++
    } else break
  }
  return i
}

export function parseKeyVals(
  content: string,
  base: number
): Map<string, { value: string; start: number; end: number }> {
  const out = new Map<string, { value: string; start: number; end: number }>()
  let offset = 0
  for (const part of content.split(",")) {
    const eq = part.indexOf("=")
    if (eq >= 0) {
      const key = part.slice(0, eq).trim()
      const raw = part.slice(eq + 1)
      const lead = raw.length - raw.trimStart().length
      const value = raw.trim()
      const start = base + offset + eq + 1 + lead
      out.set(key, { value, start, end: start + value.length })
    }
    offset += part.length + 1
  }
  return out
}

/** What a file's top level is inside: the document, or the node of the file that `\input`s it. */
export type FileContext = "document" | "regolamento" | "capo"

export function parseFile(path: string, text: string, context: FileContext = "document"): FileParse {
  const at = lineIndex(text)
  const issues: ValidationIssue[] = []
  const issue = (
    severity: ValidationIssue["severity"],
    code: string,
    message: string,
    offset: number,
    endOffset = offset + 1
  ) => {
    const { line, column } = at(offset)
    issues.push({
      file: path,
      line,
      column,
      offset,
      endOffset: Math.min(Math.max(endOffset, offset), text.length),
      severity,
      code,
      message,
    })
  }

  const root: ParsedNode = {
    kind: "file",
    id: null,
    idRange: null,
    optRange: null,
    macroEnd: 0,
    title: null,
    start: 0,
    headerEnd: 0,
    end: text.length,
    children: [],
  }
  const stack: Frame[] = [{ type: "node", node: root, envDepth: 0 }]
  const inputs: FileParse["inputs"] = []
  const refs: FileParse["refs"] = []
  const braceStack: number[] = []
  /** Brace depth of the first structural command: the others must be at the same depth. */
  let structuralDepth: number | null = null

  /** The root stands for whatever includes the file. */
  const kindOf = (node: ParsedNode): ParsedKind | FileContext => (node === root ? context : node.kind)
  const envCount = () => stack.filter((f) => f.type === "env").length
  const top = () => stack[stack.length - 1]
  const topNode = (): ParsedNode => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k]
      if (f.type === "node") return f.node
    }
    return root
  }
  const close = (frame: Frame, offset: number) => {
    if (frame.type === "node") frame.node.end = offset
  }
  /** Pops node frames (not envs) while `predicate` holds. */
  const popNodes = (offset: number, predicate: (node: ParsedNode) => boolean) => {
    for (;;) {
      const f = top()
      if (f.type !== "node" || f.node === root || !predicate(f.node)) return
      close(f, offset)
      stack.pop()
    }
  }
  /** Closes an open article with its commi and lettere (an unclosed commi or lettere environment is an error). */
  const closeArticle = (offset: number) => {
    for (;;) {
      const f = top()
      if (f.type === "env" && (f.kind === "commi" || f.kind === "lettere")) {
        issue("error", "unclosed_env", `Ambiente ${f.name} non chiuso`, f.offset, f.offset + f.name.length + 8)
        stack.pop()
        continue
      }
      if (f.type !== "node" || f.node === root) return
      const k = f.node.kind
      if (k !== "comma" && k !== "lettera" && k !== "articolo") return
      close(f, offset)
      stack.pop()
    }
  }
  /** Inside a non-structural environment other than `document`. */
  const insideGenericEnv = () => stack.some((f) => f.type === "env" && f.kind === "generic" && f.name !== "document")
  /** Within an article, a comma or a lettera: inline commands are checked there. */
  const inText = () => {
    const node = topNode()
    return node.kind === "articolo" || node.kind === "comma" || node.kind === "lettera"
  }

  const newNode = (
    kind: ParsedKind,
    start: number,
    macroEnd: number,
    withTitle: boolean
  ): { node: ParsedNode; end: number } => {
    let i = skipArgSpace(text, macroEnd)
    let id: string | null = null
    let idRange: ParsedNode["idRange"] = null
    let optRange: ParsedNode["optRange"] = null
    let end = macroEnd
    if (text[i] === "[") {
      const opt = readGroup(text, i, "[", "]")
      if (!opt) {
        issue("error", "unclosed_option", "Parentesi quadra non chiusa", i)
        return {
          node: {
            kind,
            id,
            idRange,
            optRange,
            macroEnd,
            title: null,
            start,
            headerEnd: text.length,
            end: text.length,
            children: [],
          },
          end: text.length,
        }
      }
      optRange = { start: i, end: opt.end }
      const kv = parseKeyVals(opt.content, i + 1)
      const idv = kv.get("id")
      if (idv) {
        id = idv.value
        idRange = { start: idv.start, end: idv.end }
        if (kind === "lettera")
          issue("warning", "lettera_id", "Le lettere non hanno id: viene ignorato", idv.start, idv.end)
        else if (!ID_PATTERN.test(id))
          issue("error", "invalid_id", `Id non valido "${id}": servono 6 caratteri [0-9a-z]`, idv.start, idv.end)
      }
      end = opt.end
      i = skipArgSpace(text, opt.end)
    }
    let title: string | null = null
    if (withTitle) {
      if (text[i] === "{") {
        const group = readGroup(text, i, "{", "}")
        if (!group) {
          issue("error", "unclosed_brace", "Parentesi graffa non chiusa", i)
          end = text.length
        } else {
          title = group.content.trim()
          end = group.end
          if (!title) issue("warning", "empty_title", "Titolo vuoto", start, end)
        }
      } else {
        issue("error", "missing_title", `\\${kind} richiede un titolo: \\${kind}{Titolo}`, start, macroEnd)
      }
    }
    if (kind !== "lettera" && kind !== "file" && id === null)
      issue("error", "missing_id", `\\${kind} senza id (viene assegnato automaticamente)`, start, macroEnd)
    return { node: { kind, id, idRange, optRange, macroEnd, title, start, headerEnd: end, end, children: [] }, end }
  }

  let i = 0
  while (i < text.length) {
    const ch = text.charCodeAt(i)
    if (ch === 37 /* % */) {
      const nl = text.indexOf("\n", i)
      i = nl < 0 ? text.length : nl + 1
      continue
    }
    if (ch === 123 /* { */) {
      braceStack.push(i)
      i++
      continue
    }
    if (ch === 125 /* } */) {
      if (!braceStack.length) issue("error", "unbalanced_brace", "Parentesi graffa chiusa senza apertura", i)
      else braceStack.pop()
      i++
      continue
    }
    if (ch !== 92 /* \ */) {
      i++
      continue
    }
    // A control sequence.
    const start = i
    let j = i + 1
    if (j < text.length && isLetter(text.charCodeAt(j))) {
      while (j < text.length && isLetter(text.charCodeAt(j))) j++
    } else {
      // Control symbol: \\ \% \{ \} \& …
      i = j + 1
      continue
    }
    const name = text.slice(i + 1, j)
    i = j

    if (STRUCTURAL.has(name) || name === "comma" || name === "lettera") {
      if (insideGenericEnv()) {
        issue("error", "structure_in_env", `\\${name} non può stare dentro un altro ambiente`, start, j)
        continue
      }
      if (name !== "lettera" && name !== "comma") {
        if (structuralDepth === null) structuralDepth = braceStack.length
        else if (braceStack.length !== structuralDepth)
          issue("error", "structure_in_group", `\\${name} non può stare dentro un gruppo { }`, start, j)
      }
    }

    switch (name) {
      case "regolamento": {
        // Closes everything up to the file; an open commi/lettere environment is an error.
        for (;;) {
          const f = top()
          if (f.type === "node" && f.node === root) break
          if (f.type === "env") {
            if (f.kind === "generic") break
            issue("error", "unclosed_env", `Ambiente ${f.name} non chiuso`, f.offset, f.offset + f.name.length + 8)
            if (f.kind === "capo" && f.owner) f.owner.end = start
          }
          close(f, start)
          stack.pop()
        }
        if (context !== "document")
          issue("error", "misplaced", "\\regolamento non può stare in un file incluso dentro un regolamento", start, j)
        const { node, end } = newNode("regolamento", start, j, true)
        topNode().children.push(node)
        stack.push({ type: "node", node, envDepth: envCount() })
        i = end
        break
      }
      case "articolo": {
        closeArticle(start)
        const parent = topNode()
        if (kindOf(parent) !== "regolamento" && kindOf(parent) !== "capo")
          issue("error", "misplaced", "\\articolo deve stare dentro un \\regolamento o un capo", start, j)
        const { node, end } = newNode("articolo", start, j, true)
        parent.children.push(node)
        stack.push({ type: "node", node, envDepth: envCount() })
        i = end
        break
      }
      case "comma": {
        popNodes(start, (n) => n.kind === "comma" || n.kind === "lettera")
        const f = top()
        const { node, end } = newNode("comma", start, j, false)
        if (f.type === "env" && f.kind === "commi" && f.owner) {
          f.owner.children.push(node)
          stack.push({ type: "node", node, envDepth: envCount() })
        } else {
          issue("error", "misplaced", "\\comma deve stare dentro \\begin{commi} … \\end{commi}", start, j)
        }
        i = end
        break
      }
      case "lettera": {
        popNodes(start, (n) => n.kind === "lettera")
        const f = top()
        const { node, end } = newNode("lettera", start, j, false)
        if (f.type === "env" && f.kind === "lettere" && f.owner) {
          f.owner.children.push(node)
          stack.push({ type: "node", node, envDepth: envCount() })
        } else {
          issue("error", "misplaced", "\\lettera deve stare dentro \\begin{lettere} … \\end{lettere}", start, j)
        }
        i = end
        break
      }
      case "begin":
      case "end": {
        const k = skipArgSpace(text, j)
        const group = readGroup(text, k, "{", "}")
        if (!group) {
          issue("error", "unclosed_brace", `\\${name} senza nome dell'ambiente`, start, j)
          break
        }
        const env = group.content.trim()
        i = group.end
        if (name === "begin") {
          if (env === "capo") {
            if (insideGenericEnv()) {
              issue("error", "structure_in_env", "Un capo non può stare dentro un altro ambiente", start, i)
              stack.push({ type: "env", name: env, kind: "generic", owner: null, offset: start })
              break
            }
            if (structuralDepth === null) structuralDepth = braceStack.length
            else if (braceStack.length !== structuralDepth)
              issue("error", "structure_in_group", "Un capo non può stare dentro un gruppo { }", start, i)
            closeArticle(start)
            const parent = topNode()
            if (kindOf(parent) !== "regolamento" && kindOf(parent) !== "capo")
              issue("error", "misplaced", "Un capo deve stare dentro un \\regolamento o un altro capo", start, i)
            const { node, end } = newNode("capo", start, group.end, true)
            node.macroEnd = group.end
            parent.children.push(node)
            stack.push({ type: "env", name: env, kind: "capo", owner: node, offset: start })
            stack.push({ type: "node", node, envDepth: envCount() })
            i = end
          } else if (env === "commi") {
            const owner = topNode()
            if (owner.kind !== "articolo") {
              issue("error", "misplaced", "I commi devono stare dentro un \\articolo", start, i)
              stack.push({ type: "env", name: env, kind: "commi", owner: null, offset: start })
            } else {
              if (owner.children.some((c) => c.kind === "comma"))
                issue("warning", "second_commi", "Un secondo elenco di commi nello stesso articolo", start, i)
              stack.push({ type: "env", name: env, kind: "commi", owner, offset: start })
            }
          } else if (env === "lettere") {
            const owner = topNode()
            if (owner.kind !== "comma" && owner.kind !== "articolo" && owner.kind !== "lettera") {
              issue("error", "misplaced", "Le lettere devono stare dentro un comma o un articolo", start, i)
              stack.push({ type: "env", name: env, kind: "lettere", owner: null, offset: start })
            } else stack.push({ type: "env", name: env, kind: "lettere", owner, offset: start })
          } else {
            stack.push({ type: "env", name: env, kind: "generic", owner: null, offset: start })
          }
          break
        }
        // \end{env}: close the nodes opened inside it, then the environment.
        const index = stack.findLastIndex((f) => f.type === "env" && f.name === env)
        if (index < 0) {
          issue("error", "unmatched_end", `\\end{${env}} senza \\begin{${env}}`, start, i)
          break
        }
        for (let k2 = stack.length - 1; k2 > index; k2--) {
          const f = stack[k2]
          if (f.type === "env")
            issue(
              "error",
              "unclosed_env",
              `Ambiente ${f.name} non chiuso prima di \\end{${env}}`,
              f.offset,
              f.offset + 1
            )
          // A capo spans its \end{capo}; nodes inside it end where it starts.
          close(f, f.type === "node" && f.node.kind === "capo" ? i : start)
        }
        stack.length = index
        break
      }
      case "rif": {
        const k = skipArgSpace(text, j)
        const group = readGroup(text, k, "{", "}")
        if (!group) issue("error", "unclosed_brace", "\\rif senza id", start, j)
        else {
          refs.push({ id: group.content.trim(), start, end: group.end })
          i = group.end
        }
        break
      }
      case "input":
      case "include": {
        const k = skipArgSpace(text, j)
        const group = readGroup(text, k, "{", "}")
        if (group) {
          let target = normalizePath(group.content.trim())
          if (!/\.tex$/.test(target)) target += ".tex"
          // An included file holds structure: it ends the article before it (unless inside its commi).
          if (!stack.some((f) => f.type === "env" && (f.kind === "commi" || f.kind === "lettere"))) closeArticle(start)
          inputs.push({ path: target, offset: start, parent: topNode() })
          i = group.end
        }
        break
      }
      default:
        if (inText() && !INLINE_ALLOWED.has(name))
          issue("warning", "free_latex", `Comando \\${name} fuori dal sottoinsieme consentito nel testo`, start, j)
    }
  }

  for (let k = stack.length - 1; k > 0; k--) {
    const f = stack[k]
    if (f.type === "env" && f.kind !== "generic")
      issue("error", "unclosed_env", `Ambiente ${f.name} non chiuso`, f.offset, f.offset + f.name.length + 8)
    close(f, text.length)
  }
  for (const offset of braceStack) issue("error", "unbalanced_brace", "Parentesi graffa non chiusa", offset)

  return { path, text, root, issues, inputs, refs }
}
