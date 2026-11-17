import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { readDocument, readDocumentWith } from "./compile/assets"
import type { AssetBundle } from "./compile/protocol"
import type { LegalGitHub } from "./emanation/github"

/** `legal.json` at the root of PoliNetworkOrg/legal. */
export const manifestSchema = z.object({
  version: z.literal(1),
  shared: z.string(),
  documents: z.array(
    z.object({
      key: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      title: z.string(),
      dir: z.string(),
      entry: z.string(),
      sources: z.array(z.string()),
      outputs: z.record(z.string(), z.string()),
      tagPrefix: z.string(),
      /** `null`: edited by hand, not managed by the dashboard. */
      procedure: z.string().nullable(),
    })
  ),
})
export type LegalManifest = z.infer<typeof manifestSchema>
export type LegalDocument = LegalManifest["documents"][number]

/** Where the backend reads the legal repository from: a local clone (development) or GitHub (the App). */
export type LegalSource = {
  /** The commit the reads below come from. */
  head(): Promise<{ sha: string | null; label: string }>
  manifest(): Promise<LegalManifest>
  readDocument(
    document: LegalDocument,
    shared: string
  ): Promise<{ sources: Record<string, string>; assets: AssetBundle }>
}

/** A local checkout, e.g. `REGULATIONS_LEGAL_DIR=../legal` for development and the end-to-end setup. */
export function localLegalSource(root: string): LegalSource {
  return {
    async head() {
      const proc = Bun.spawn(["git", "-C", root, "rev-parse", "HEAD"], { stdout: "pipe", stderr: "ignore" })
      const sha = (await new Response(proc.stdout).text()).trim()
      return (await proc.exited) === 0 && sha
        ? { sha, label: `import ${sha.slice(0, 7)}` }
        : { sha: null, label: "import" }
    },
    async manifest() {
      return manifestSchema.parse(JSON.parse(await readFile(join(root, "legal.json"), "utf8")))
    },
    readDocument: (document, shared) => readDocument(root, { ...document, shared }),
  }
}

/** The legal repository on GitHub, through the App, at the head of `ref`. */
export function githubLegalSource(gh: LegalGitHub, ref: string): LegalSource {
  let pinned: string | null = null
  const sha = async () => {
    pinned ??= await gh.headSha(ref)
    return pinned
  }
  return {
    async head() {
      pinned = null
      const head = await sha()
      return { sha: head, label: `import ${head.slice(0, 7)}` }
    },
    async manifest() {
      const text = await gh.readText("legal.json", await sha())
      if (!text) throw new Error("legal.json not found in the legal repository")
      return manifestSchema.parse(JSON.parse(text))
    },
    async readDocument(document, shared) {
      const at = await sha()
      return readDocumentWith(
        {
          list: (dir) => gh.listFiles(dir, at),
          read: async (path) => {
            const bytes = await gh.readBytes(path, at)
            if (!bytes) throw new Error(`${path} not found`)
            return bytes
          },
        },
        { ...document, shared }
      )
    },
  }
}
