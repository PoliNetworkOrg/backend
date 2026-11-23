import { constants } from "node:fs"
import { lstat, open, realpath, unlink } from "node:fs/promises"
import { basename, dirname, join, parse, resolve } from "node:path"
import { parseArgs } from "node:util"
import { CsvPreviewError } from "../src/soci/import-csv"
import { type BookDiagnostic, previewBookCsv, ROW_WARNINGS } from "../src/soci/import-preview"

async function readLocalText(path: string, limit: number, kind: "input" | "mapping") {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK).catch(() => {
    throw new CsvPreviewError(`${kind}_unreadable`)
  })
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new CsvPreviewError(`${kind}_not_regular`)
    if (stat.size > limit) throw new CsvPreviewError(`${kind}_too_large`)
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > limit) throw new CsvPreviewError(`${kind}_too_large`)
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length))
    } catch {
      throw new CsvPreviewError(`${kind}_invalid_utf8`)
    }
  } finally {
    await handle.close()
  }
}

async function saveReport(path: string, report: unknown) {
  try {
    const parent = await realpath(dirname(resolve(path)))
    for (let directory = parent; ; directory = dirname(directory)) {
      const git = await lstat(join(directory, ".git")).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return null
      })
      if (git) throw new CsvPreviewError("output_inside_git")
      if (directory === parse(directory).root) break
    }
    const text = `${JSON.stringify(report, null, 2)}\n`
    const target = join(parent, basename(resolve(path)))
    const handle = await open(target, "wx", 0o600)
    let failure: unknown = null
    await handle.writeFile(text, "utf8").catch((error: unknown) => {
      failure = error
    })
    await handle.close().catch((error: unknown) => {
      failure ??= error
    })
    if (failure !== null) {
      // Never leave a partial personal-data report behind; say so if it could not be removed.
      await unlink(target).catch(() => {
        throw new CsvPreviewError("output_partial")
      })
      throw failure
    }
  } catch (error) {
    if (error instanceof CsvPreviewError) throw error
    throw new CsvPreviewError("output_unwritable")
  }
}

async function main() {
  let args: ReturnType<typeof parseArgs>
  try {
    args = parseArgs({
      options: {
        input: { type: "string" },
        mapping: { type: "string" },
        out: { type: "string" },
        help: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    })
  } catch {
    throw new CsvPreviewError("invalid_arguments")
  }
  if (args.values.help) {
    console.log(
      "Anteprima locale CSV Libro Soci\nUso: bun --no-env-file scripts/soci-import-preview.ts --input libro.csv --mapping colonne.json [--out report.json]\nNessuna applicazione al registro. Report dettagliato facoltativo, privato e fuori da Git."
    )
    return
  }
  const { input, mapping, out } = args.values
  if (typeof input !== "string" || typeof mapping !== "string" || (out !== undefined && typeof out !== "string"))
    throw new CsvPreviewError("invalid_arguments")
  const configText = await readLocalText(mapping, 65_536, "mapping")
  let config: unknown
  try {
    config = JSON.parse(configText)
  } catch {
    throw new CsvPreviewError("mapping_invalid_json")
  }
  const source = await readLocalText(input, 10 * 1024 * 1024, "input")
  const report = previewBookCsv(source, config)
  if (out !== undefined) await saveReport(out, report)
  console.log("Anteprima locale: riconciliazione non eseguita; nessuna riga pronta per l'importazione.")
  console.log(
    `Righe: ${report.summary.rows}; normalizzate: ${report.summary.normalized}; bloccate: ${report.summary.blocked}; da verificare: ${report.summary.unresolved}.`
  )
  // Errors first, so blocked rows are named even in long books; warnings every row carries are only counted.
  const listed: { line: number; diagnostic: BookDiagnostic }[] = []
  const counted = new Map<string, number>()
  for (const severity of ["error", "warning"] as const)
    for (const row of report.rows)
      for (const diagnostic of row.diagnostics) {
        if (diagnostic.severity !== severity) continue
        if (severity === "warning" && ROW_WARNINGS.includes(diagnostic.code))
          counted.set(diagnostic.code, (counted.get(diagnostic.code) ?? 0) + 1)
        else listed.push({ line: row.line, diagnostic })
      }
  for (const { line, diagnostic } of listed.slice(0, 100))
    console.log(
      `Riga ${line}: ${diagnostic.severity} ${diagnostic.code}${diagnostic.field ? ` [${diagnostic.field}]` : ""}${diagnostic.relatedLine ? ` (riga correlata ${diagnostic.relatedLine})` : ""}`
    )
  if (listed.length > 100)
    console.log(`Altre diagnostiche: ${listed.length - 100}. Usare --out per il report completo.`)
  for (const [code, count] of counted) console.log(`Avvisi ${code}: ${count} righe.`)
  if (out !== undefined) console.log("Report dettagliato salvato localmente con permessi privati.")
  process.exitCode = report.summary.blocked ? 2 : 0
}

main().catch((error: unknown) => {
  if (error instanceof CsvPreviewError)
    console.error(
      `Errore: ${error.code}${error.line ? `; riga ${error.line}` : ""}${error.column ? `; colonna ${error.column}` : ""}.`
    )
  else console.error("Errore: internal_error.")
  process.exitCode = 1
})
