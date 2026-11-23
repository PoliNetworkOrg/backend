export class CsvPreviewError extends Error {
  constructor(
    readonly code: string,
    readonly line?: number,
    readonly column?: number
  ) {
    super(code)
    this.name = "CsvPreviewError"
  }
}

export type CsvRecord = { line: number; cells: string[] }

/**
 * Strict quoted CSV. Blank physical lines, including lines of unquoted whitespace only, are skipped; explicit empty
 * records (a delimiter or a quoted cell) are retained. Cell lengths count Unicode characters, not UTF-16 units.
 */
export function parseBookCsv(source: string, delimiter: "," | ";"): CsvRecord[] {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source
  const records: CsvRecord[] = []
  let state: "start" | "plain" | "quoted" | "closed" = "start"
  let cells: string[] = []
  let cell = ""
  let cellLength = 0
  let line = 1
  let startLine = 1
  let present = false

  const append = (value: string) => {
    cell += value
    // Count code points: a low surrogate completes a character already counted by its high surrogate.
    for (let i = 0; i < value.length; i++) {
      const unit = value.charCodeAt(i)
      if (unit < 0xdc00 || unit > 0xdfff) cellLength++
    }
    if (cellLength > 16_384) throw new CsvPreviewError("cell_too_long", startLine)
  }
  const field = () => {
    cells.push(cell)
    if (cells.length > 256) throw new CsvPreviewError("too_many_columns", startLine)
    cell = ""
    cellLength = 0
    state = "start"
  }
  const record = () => {
    const whitespaceOnly = cells.length === 0 && state === "plain" && cell.trim() === ""
    if (present && !whitespaceOnly) {
      field()
      records.push({ line: startLine, cells })
      if (records.length > 50_001) throw new CsvPreviewError("too_many_rows", startLine)
    }
    cells = []
    cell = ""
    cellLength = 0
    state = "start"
    present = false
  }

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === "\r" || ch === "\n") {
      const newline = ch === "\r" && text[i + 1] === "\n" ? "\r\n" : ch
      if (newline.length === 2) i++
      if (state === "quoted") append(newline)
      else record()
      line++
      if (state !== "quoted") startLine = line
      continue
    }
    present = true
    if (state === "quoted") {
      if (ch !== '"') append(ch)
      else if (text[i + 1] === '"') {
        append('"')
        i++
      } else state = "closed"
    } else if (ch === delimiter) field()
    else if (ch === '"' && state === "start") state = "quoted"
    else if (state === "closed") throw new CsvPreviewError("characters_after_quote", line)
    else if (ch === '"') throw new CsvPreviewError("unexpected_quote", line)
    else {
      state = "plain"
      append(ch)
    }
  }
  if (state === "quoted") throw new CsvPreviewError("unclosed_quote", startLine)
  record()
  return records
}
