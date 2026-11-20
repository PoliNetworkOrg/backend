import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { basename, dirname, join, parse, resolve } from "node:path"
import { parseArgs } from "node:util"
import { CsvPreviewError } from "../src/soci/import-csv"
import { previewBookCsv } from "../src/soci/import-preview"

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
    const handle = await open(join(parent, basename(resolve(path))), "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`, "utf8")
    } finally {
      await handle.close()
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
  let emitted = 0
  let total = 0
  for (const row of report.rows)
    for (const diagnostic of row.diagnostics) {
      total++
      if (emitted >= 100) continue
      console.log(
        `Riga ${row.line}: ${diagnostic.severity} ${diagnostic.code}${diagnostic.field ? ` [${diagnostic.field}]` : ""}${diagnostic.relatedLine ? ` (riga correlata ${diagnostic.relatedLine})` : ""}`
      )
      emitted++
    }
  if (total > emitted) console.log(`Altre diagnostiche: ${total - emitted}. Usare --out per il report completo.`)
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
