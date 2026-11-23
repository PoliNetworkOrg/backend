import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const script = fileURLToPath(new URL("../scripts/soci-import-preview.ts", import.meta.url))
const config = {
  version: 1,
  delimiter: ";",
  dateFormat: "iso",
  scope: "unknown",
  columns: {
    number: "Numero",
    firstName: "Nome",
    lastName: "Cognome",
    admittedOn: "Data",
    codiceFiscale: "CF",
    mailbox: "Email",
  },
}
const csv =
  "Numero;Nome;Cognome;Data;CF;Email\n123;PersonaPrivata;CognomePrivato;2025-09-01;RSSMRA80A01H501U;privata@example.test"
let directory: string
let input: string
let mapping: string
function run(extra: string[] = [], override: string[] | null = null) {
  const result = spawnSync(
    "bun",
    ["--no-env-file", script, ...(override ?? ["--input", input, "--mapping", mapping]), ...extra],
    {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: process.env.PATH },
      timeout: 10_000,
    }
  )
  expect(result.error).toBeUndefined()
  const output = result.stdout + result.stderr
  for (const secret of ["PersonaPrivata", "CognomePrivato", "RSSMRA80A01H501U", "privata@example.test", directory])
    expect(output).not.toContain(secret)
  return { ...result, output }
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "soci-csv-test-"))
  input = join(directory, "private.csv")
  mapping = join(directory, "mapping.json")
  await writeFile(input, csv)
  await writeFile(mapping, JSON.stringify(config))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

// Each test spawns Bun up to four times; the 5 s default is too tight on a loaded runner.
describe("credential-free CSV preview command", { timeout: 60_000 }, () => {
  it("runs offline with no service configuration and only redacted console diagnostics", async () => {
    const result = run()
    expect(result.status).toBe(0)
    expect(result.output).toContain("Righe: 1; normalizzate: 1; bloccate: 0; da verificare: 1.")
    expect(result.output).toContain("account_unreconciled")
    expect((await stat(input)).size).toBe(Buffer.byteLength(csv))
  })
  it("writes a private detailed report only with --out and never overwrites it", async () => {
    const path = join(directory, "report.json")
    expect(run(["--out", path]).status).toBe(0)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    const text = await readFile(path, "utf8")
    const report = JSON.parse(text)
    expect(report.rows[0].candidate.details.firstName).toBe("PersonaPrivata")
    expect(report.mode).toBe("preview-only")
    expect(run(["--out", path])).toMatchObject({ status: 1, stderr: "Errore: output_unwritable.\n" })
    expect(await readFile(path, "utf8")).toBe(text)
  })
  it("rejects symlink outputs and outputs inside Git repositories, including aliased parents", async () => {
    const output = join(directory, "alias.json")
    await symlink(input, output)
    expect(run(["--out", output]).status).toBe(1)
    expect(await readFile(input, "utf8")).toBe(csv)
    const repo = join(directory, "repo")
    await mkdir(join(repo, "nested"), { recursive: true })
    await writeFile(join(repo, ".git"), "gitdir: elsewhere")
    await symlink(join(repo, "nested"), join(directory, "alias-parent"))
    expect(run(["--out", join(directory, "alias-parent", "report.json")])).toMatchObject({
      status: 1,
      stderr: "Errore: output_inside_git.\n",
    })
  })
  it("names blocked rows before the warnings every row carries", async () => {
    const rows = Array.from({ length: 300 }, (_, i) => `${i + 1};Nome;Cognome;2025-09-01;;`)
    rows[248] = "249;Nome;Cognome;2025-02-30;;"
    await writeFile(input, ["Numero;Nome;Cognome;Data;CF;Email", ...rows].join("\n"))
    const result = run()
    expect(result.status).toBe(2)
    expect(result.stdout.split("\n")[2]).toBe("Riga 250: error invalid_value [admittedOn]")
    expect(result.output).toContain("Avvisi account_unreconciled: 299 righe.")
    expect(result.output).not.toContain("Altre diagnostiche")
  })
  it("returns status 2 for blocked rows and can still save their detailed report", async () => {
    await writeFile(input, csv.replace("2025-09-01", "2025-02-30"))
    const output = join(directory, "blocked.json")
    expect(run(["--out", output]).status).toBe(2)
    const report = JSON.parse(await readFile(output, "utf8"))
    expect(report.rows[0].candidate).toBeNull()
    expect(report.summary.blocked).toBe(1)
  })
  it("does not echo unexpected arguments, headers, invalid JSON or input paths", async () => {
    expect(run([], ["--apply=PersonaPrivata"])).toMatchObject({ status: 1, stderr: "Errore: invalid_arguments.\n" })
    await writeFile(input, `${csv};PersonaPrivata`.replace("Email\n", "Email;PersonaPrivata\n"))
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: unmapped_column; riga 1; colonna 7.\n" })
    await writeFile(mapping, "PersonaPrivata")
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: mapping_invalid_json.\n" })
    await writeFile(mapping, JSON.stringify(config))
    await rm(input)
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: input_unreadable.\n" })
  })
  it("bounds files and rejects invalid UTF-8 and nonregular inputs", async () => {
    await writeFile(input, Buffer.from([0xc3, 0x28]))
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: input_invalid_utf8.\n" })
    await writeFile(input, Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: input_too_large.\n" })
    await rm(input)
    await mkdir(input)
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: input_not_regular.\n" })
    await writeFile(mapping, "x".repeat(65_537))
    expect(run()).toMatchObject({ status: 1, stderr: "Errore: mapping_too_large.\n" })
  })
})
