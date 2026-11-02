/**
 * Seeds the local regulations stack through the real API, as the dev accounts:
 * imports legal.json and the RRI from REGULATIONS_LEGAL_DIR, creates two drafts that change the same comma (a merge
 * conflict) and one with a clean change, assigns the editor and commenter accounts, and waits for the first PDF.
 *   bun run regulations:seed
 */
import superjson from "superjson"
import { createCollabControl } from "@/regulations/collab/internal-client"
import { DEV_ENV } from "./dev"
import { userToken } from "./dev-idp"

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000"

async function call<T>(
  sub: string,
  path: string,
  input?: unknown,
  kind: "query" | "mutation" = "mutation"
): Promise<T> {
  const token = await userToken(sub)
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  const url = `${BACKEND}/api/trpc/${path}`
  const response =
    kind === "query"
      ? await fetch(`${url}?input=${encodeURIComponent(JSON.stringify(superjson.serialize(input)))}`, { headers })
      : await fetch(url, { method: "POST", headers, body: JSON.stringify(superjson.serialize(input)) })
  const body = (await response.json()) as { result?: { data: { json: unknown; meta?: never } }; error?: unknown }
  if (!response.ok || !body.result) throw new Error(`${path}: ${JSON.stringify(body.error ?? body)}`)
  return superjson.deserialize(body.result.data as never) as T
}

const collab = createCollabControl({
  url: DEV_ENV.REGULATIONS_COLLAB_INTERNAL_URL,
  secret: DEV_ENV.REGULATIONS_INTERNAL_SECRET,
})

const SEG = "dev-segretario"
const DIR = "dev-direttivo"

const sync = await call<{ documents: string[]; imported: string[] }>(SEG, "regulations.documents.sync")
console.log("documents:", sync)
const versions = await call<{ id: string; label: string }[]>(
  SEG,
  "regulations.versions.list",
  { documentKey: "rri" },
  "query"
)
const version = versions[0]
console.log("version:", version.label)

const create = (title: string) =>
  call<{ id: string }>(DIR, "regulations.drafts.create", {
    documentKey: "rri",
    title,
    from: { kind: "version", id: version.id },
    kind: "modifica",
  })
const a = await create("Revisione Team (A)")
const b = await create("Revisione Team (B, in conflitto con A)")
const c = await create("Correzione notifiche (C, senza conflitti)")
for (const draft of [a, b, c]) {
  await call(DIR, "regulations.assignments.set", { draftId: draft.id, userId: "dev-editor", role: "editor" })
  await call(DIR, "regulations.assignments.set", { draftId: draft.id, userId: "dev-commenter", role: "commenter" })
}

// A and B change the same comma; C changes another article.
const files = await collab.text(a.id)
const path = "regolamenti/2_interno.tex"
const original = "Ciascun Team è amministrato, per un anno, da un Team Lead."
if (!files[path]?.includes(original)) throw new Error(`the seed expects "${original}" in ${path}`)
await collab.replace(a.id, {
  ...files,
  [path]: files[path].replace(original, "Ciascun Team è amministrato, per due anni, da un Team Lead."),
})
await collab.replace(b.id, {
  ...files,
  [path]: files[path].replace(original, "Ciascun Team è amministrato, per un anno, da due Team Lead."),
})
const notifiche = "Le notifiche, se non specificato diversamente, devono avvenire entro 30 giorni."
const fondamentale = "regolamenti/1_fondamentale.tex"
await collab.replace(c.id, {
  ...files,
  [fondamentale]: files[fondamentale].replace(notifiche, notifiche.replace("30 giorni", "trenta giorni")),
})

const preview = await call<{ conflicts: { label: string }[] }>(
  DIR,
  "regulations.merge.preview",
  { targetDraftId: a.id, source: { kind: "draft", id: b.id } },
  "query"
)
console.log(
  "merge B → A conflicts:",
  preview.conflicts.map((x) => x.label)
)

for (let i = 0; i < 60; i++) {
  const status = await call<{ state: string; lastGoodHash: string | null }>(
    DIR,
    "regulations.compile.status",
    { draftId: a.id },
    "query"
  )
  if (status.state === "ok" || status.state === "error") {
    console.log("first compile of A:", status.state)
    break
  }
  await new Promise((r) => setTimeout(r, 1000))
}
console.log(JSON.stringify({ drafts: { a: a.id, b: b.id, c: c.id } }))
