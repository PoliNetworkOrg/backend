import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { listTree, notHidden, type RepoReader, readDocumentWith, readTreeWith } from "./compile/assets"
import type { AssetBundle } from "./compile/protocol"
import { documentKeySchema, procedureKeySchema } from "./contract"
import type { LegalGitHub } from "./emanation/github"

/** The manifest at the root of the documents repository (PoliNetworkOrg/documents, formerly `legal`). */
export const MANIFEST_PATH = "documents.json"

const repoPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith("/") && !p.split("/").some((part) => part === ".." || part === "."),
    "not a relative path"
  )
  .transform((p) => p.replace(/\/+$/, ""))

export const templateKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)

export const manifestTemplateSchema = z.object({
  title: z.string().min(1),
  /** Class, `.sty` files, fonts and images: the whole tree is available to the compile, under `shared/`. */
  shared: repoPath,
  /** The starting files of a new document (`{{TITLE}}`, `{{KEY}}`, `{{DATE}}` placeholders in `.tex` files). */
  skeleton: repoPath,
})

export const manifestDocumentSchema = z.object({
  key: documentKeySchema,
  title: z.string().min(1),
  dir: repoPath,
  entry: z.string().regex(/^[^/].*\.tex$/),
  sources: z.array(z.string().min(1)),
  outputs: z.object({ pdf: z.string().min(1) }).catchall(z.string()),
  tagPrefix: z.string().min(1),
  /** Key in `templates`, or `null`: a self-contained directory (Statuto, Elettorale). */
  template: templateKeySchema.nullable(),
  /** `null`: sola consultazione, never edited from the dashboard. */
  procedure: procedureKeySchema.nullable(),
})

/** `documents.json`, version 2 (Addendum 2026-11-22 of the shared spec). */
export const manifestSchema = z
  .object({
    version: z.literal(2),
    templates: z.record(templateKeySchema, manifestTemplateSchema),
    documents: z.array(manifestDocumentSchema),
  })
  .superRefine((manifest, ctx) => {
    const keys = new Set<string>()
    manifest.documents.forEach((doc, i) => {
      if (keys.has(doc.key)) ctx.addIssue({ code: "custom", path: ["documents", i, "key"], message: "duplicate key" })
      keys.add(doc.key)
      if (doc.template !== null && !(doc.template in manifest.templates))
        ctx.addIssue({
          code: "custom",
          path: ["documents", i, "template"],
          message: `unknown template ${doc.template}`,
        })
    })
  })
export type LegalManifest = z.infer<typeof manifestSchema>
export type LegalDocument = LegalManifest["documents"][number]
export type ManifestTemplate = LegalManifest["templates"][string]

/** `documents.json` is missing or doesn't match the schema: the message says which, in Italian, for the dashboard. */
export class ManifestError extends Error {}

export function parseManifest(text: string | null): LegalManifest {
  if (text === null) throw new ManifestError(`${MANIFEST_PATH} non trovato nel repository dei documenti.`)
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    throw new ManifestError(`${MANIFEST_PATH} non è JSON valido.`)
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue?.path.length ? ` (${issue.path.join(".")})` : ""
    throw new ManifestError(`${MANIFEST_PATH} non è valido${where}: ${issue?.message ?? "formato sconosciuto"}.`)
  }
  return parsed.data
}

/** A template's files, by path relative to its `skeleton` and `shared` directories. */
export type TemplateFiles = { skeleton: Record<string, Uint8Array>; shared: Record<string, Uint8Array> }

/** Where the backend reads the documents repository from: a local clone (development) or GitHub (the App). */
export type LegalSource = {
  /** The commit the reads below come from (pinned until the next `head()`). */
  head(): Promise<{ sha: string | null; label: string }>
  /** Throws a `ManifestError` when `documents.json` is missing or invalid. */
  manifest(): Promise<LegalManifest>
  /** The document's sources and asset bundle (its directory's other files, plus the template's whole shared tree). */
  readDocument(
    document: LegalDocument,
    template: ManifestTemplate | null
  ): Promise<{ sources: Record<string, string>; assets: AssetBundle }>
  readTemplate(template: ManifestTemplate): Promise<TemplateFiles>
  /** Whether anything exists under `dir`. */
  exists(dir: string): Promise<boolean>
}

function sourceOver(reader: RepoReader, readManifest: () => Promise<string | null>) {
  return {
    async manifest() {
      return parseManifest(await readManifest())
    },
    readDocument: (document: LegalDocument, template: ManifestTemplate | null) =>
      readDocumentWith(reader, { ...document, shared: template?.shared ?? null }),
    async readTemplate(template: ManifestTemplate): Promise<TemplateFiles> {
      return {
        // Everything a new document starts with, latexmkrc included (it points at the shared directory).
        skeleton: await readTreeWith(reader, template.skeleton, notHidden),
        shared: await readTreeWith(reader, template.shared),
      }
    },
    async exists(dir: string) {
      return (await reader.list(dir)).length > 0
    },
  }
}

/** A local checkout, e.g. `REGULATIONS_LEGAL_DIR=../documents` for development and the end-to-end setup. */
export function localLegalSource(root: string): LegalSource {
  const reader: RepoReader = {
    list: async (dir) => {
      try {
        return await listTree(join(root, dir))
      } catch (error) {
        if ((error as { code?: string }).code === "ENOENT" || (error as { code?: string }).code === "ENOTDIR") return []
        throw error
      }
    },
    read: async (path) => new Uint8Array(await readFile(join(root, path))),
  }
  return {
    async head() {
      const proc = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
      const sha = (await new Response(proc.stdout).text()).trim()
      return (await proc.exited) === 0 && sha
        ? { sha, label: `import ${sha.slice(0, 7)}` }
        : { sha: null, label: "import" }
    },
    ...sourceOver(reader, () => readFile(join(root, MANIFEST_PATH), "utf8").catch(() => null)),
  }
}

/** The documents repository on GitHub, through the App, at the head of `ref`. */
export function githubLegalSource(gh: LegalGitHub, ref: string): LegalSource {
  let pinned: string | null = null
  // Files read at the pinned commit: documents sharing a template read its fonts once per sync.
  let cache = new Map<string, Uint8Array>()
  const sha = async () => {
    pinned ??= await gh.headSha(ref)
    return pinned
  }
  const reader: RepoReader = {
    list: async (dir) => gh.listFiles(dir, await sha()),
    read: async (path) => {
      // The cache of the commit this read started at: a `head()` meanwhile starts a new one, which this can't pollute.
      const at = cache
      const cached = at.get(path)
      if (cached) return cached
      const bytes = await gh.readBytes(path, await sha())
      if (!bytes) throw new Error(`${path} not found`)
      if (at === cache) at.set(path, bytes)
      return bytes
    },
  }
  return {
    async head() {
      pinned = null
      cache = new Map()
      const head = await sha()
      return { sha: head, label: `import ${head.slice(0, 7)}` }
    },
    ...sourceOver(reader, async () => gh.readText(MANIFEST_PATH, await sha())),
  }
}

/**
 * Appends a document to documents.json as text, in the repository's style (two-space indentation, one key per line,
 * arrays of strings inline), so a creation pull request's diff is only the new entry. Falls back to a full
 * `JSON.stringify` when the file's layout can't be followed.
 */
export function appendDocumentEntry(text: string, entry: Record<string, unknown>): string {
  const manifest = JSON.parse(text) as { documents?: unknown[] }
  const documents = manifest.documents
  if (!Array.isArray(documents)) throw new Error(`${MANIFEST_PATH} non ha l'elenco dei documenti.`)
  const expected = JSON.stringify([...documents, entry])
  const fallback = () => `${JSON.stringify({ ...manifest, documents: [...documents, entry] }, null, 2)}\n`
  const close = documentsArrayEnd(text)
  if (close === null) return fallback()
  const lineStart = (at: number) => text.lastIndexOf("\n", at - 1) + 1
  const indentAt = (at: number) => /^[ \t]*/.exec(text.slice(lineStart(at)))?.[0] ?? ""
  const unit = /\n([ \t]+)\S/.exec(text)?.[1] ?? "  "
  const closeIndent = indentAt(close)
  let last = close - 1
  while (last >= 0 && /\s/.test(text[last])) last--
  const empty = text[last] === "["
  // The last entry's closing brace sits on a line with the entries' indentation.
  const itemIndent = empty ? closeIndent + unit : indentAt(last)
  const formatted = formatJson(entry, itemIndent, unit)
  const result = empty
    ? `${text.slice(0, last + 1)}\n${itemIndent}${formatted}\n${closeIndent}${text.slice(close)}`
    : `${text.slice(0, last + 1)},\n${itemIndent}${formatted}${text.slice(last + 1)}`
  try {
    if (JSON.stringify((JSON.parse(result) as { documents: unknown[] }).documents) === expected) return result
  } catch {
    // Not followed: write the whole file instead.
  }
  return fallback()
}

/** Objects one key per line; arrays of primitives inline (`["a", "b"]`), other arrays one item per line. */
function formatJson(value: unknown, indent: string, unit: string): string {
  if (Array.isArray(value)) {
    if (value.every((v) => v === null || typeof v !== "object"))
      return `[${value.map((v) => JSON.stringify(v)).join(", ")}]`
    return `[\n${value.map((v) => indent + unit + formatJson(v, indent + unit, unit)).join(",\n")}\n${indent}]`
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value)
    if (!entries.length) return "{}"
    return `{\n${entries
      .map(([k, v]) => `${indent}${unit}${JSON.stringify(k)}: ${formatJson(v, indent + unit, unit)}`)
      .join(",\n")}\n${indent}}`
  }
  return JSON.stringify(value)
}

/** Offset of the `]` closing the top-level `"documents"` array, or null. */
function documentsArrayEnd(text: string): number | null {
  let depth = 0
  let inString = false
  let key: string | null = null
  let stringStart = 0
  let arrayDepth: number | null = null
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inString) {
      if (c === "\\") i++
      else if (c === '"') {
        inString = false
        key = text.slice(stringStart + 1, i)
      }
      continue
    }
    if (c === '"') {
      inString = true
      stringStart = i
    } else if (c === "{" || c === "[") {
      if (c === "[" && depth === 1 && key === "documents" && arrayDepth === null) arrayDepth = depth + 1
      depth++
    } else if (c === "}" || c === "]") {
      if (c === "]" && arrayDepth !== null && depth === arrayDepth) return i
      depth--
    } else if (c === ",") key = null
  }
  return null
}
