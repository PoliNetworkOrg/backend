import Anthropic from "@anthropic-ai/sdk"
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod"
import { z } from "zod/v4"
import type { ArticleChange } from "../contract"

/**
 * Turns a structural diff into categories for people: changes grouped by theme, each with the articles involved.
 * The provider is chosen by env (REGULATIONS_LLM_PROVIDER); the model is configuration too (spec decision 9), never
 * hardcoded. The fake one is deterministic, for tests and development.
 */
export type DiffInput = {
  documentTitle: string
  baseLabel: string
  articles: ArticleChange[]
  otherChanges: string[]
}

export type DiffCategory = { title: string; summary: string; articleIds: string[] }

export type DiffSummarizer = {
  provider: string
  model: string | null
  summarize(input: DiffInput): Promise<DiffCategory[]>
}

const KIND_GROUPS: { kinds: ArticleChange["kind"][]; title: string }[] = [
  { kinds: ["added"], title: "Nuovi articoli" },
  { kinds: ["modified"], title: "Articoli modificati" },
  { kinds: ["removed"], title: "Articoli abrogati" },
  { kinds: ["moved", "renumbered"], title: "Articoli spostati o rinumerati" },
]

/** Deterministic: one category per kind of change. */
export function fakeSummarizer(): DiffSummarizer {
  return {
    provider: "fake",
    model: null,
    async summarize(input) {
      return KIND_GROUPS.flatMap(({ kinds, title }) => {
        const articles = input.articles.filter((a) => kinds.includes(a.kind))
        if (!articles.length) return []
        const labels = articles.map((a) => (a.newLabel ?? a.oldLabel ?? a.id).split(" — ")[0])
        return [
          {
            title,
            summary: `${articles.length === 1 ? "Un articolo" : `${articles.length} articoli`}: ${labels.join(", ")}.`,
            articleIds: articles.map((a) => a.id),
          },
        ]
      })
    },
  }
}

const outputSchema = z.object({
  categories: z
    .array(
      z.object({
        title: z.string().describe("Tema della modifica, breve (es. «Team e Team Lead»)"),
        summary: z.string().describe("Cosa cambia per i Soci, in una o due frasi, senza giudizi"),
        articleIds: z.array(z.string()).describe("Id degli articoli coinvolti, presi dall'elenco"),
      })
    )
    .describe("Le modifiche raggruppate per tema"),
})

const SYSTEM = `Sei il Segretario di un'associazione studentesca e prepari il «documento delle differenze» tra due versioni dei suoi regolamenti, richiesto dal Regolamento Fondamentale: deve evidenziare soltanto le differenze e non ha valore ufficiale.

Ricevi l'elenco degli articoli cambiati, ciascuno con un id, il tipo di modifica e il testo prima e dopo. Raggruppa le modifiche per tema (non per tipo di modifica) in poche categorie, ognuna con un titolo breve, un riassunto neutro di una o due frasi su cosa cambia in concreto, e gli id degli articoli coinvolti. Ogni articolo deve stare in almeno una categoria; usa solo id presenti nell'elenco. Gli articoli soltanto rinumerati o spostati senza cambiare testo vanno insieme in una categoria a parte. Scrivi in italiano, senza esprimere opinioni sulle modifiche.`

function describe(input: DiffInput): string {
  const parts = [`Documento: ${input.documentTitle}`, `Confronto con: ${input.baseLabel}`, ""]
  for (const a of input.articles) {
    parts.push(`### id=${a.id} · ${a.kind}`)
    if (a.oldLabel) parts.push(`Prima: ${a.oldLabel}`)
    if (a.newLabel) parts.push(`Dopo: ${a.newLabel}`)
    if (a.kind === "modified" || a.kind === "removed") parts.push(`Testo precedente:\n${a.oldText ?? ""}`)
    if (a.kind === "modified" || a.kind === "added") parts.push(`Testo nuovo:\n${a.newText ?? ""}`)
    parts.push("")
  }
  if (input.otherChanges.length)
    parts.push("Altre modifiche (fuori dagli articoli):", ...input.otherChanges.map((c) => `- ${c}`))
  return parts.join("\n")
}

/** Claude through the Anthropic SDK, with structured outputs. */
export function anthropicSummarizer(options: {
  apiKey: string
  model: string
  effort?: "low" | "medium" | "high" | "xhigh" | "max"
  client?: Anthropic
}): DiffSummarizer {
  const client = options.client ?? new Anthropic({ apiKey: options.apiKey })
  return {
    provider: "anthropic",
    model: options.model,
    async summarize(input) {
      const response = await client.messages.parse({
        model: options.model,
        max_tokens: 16000,
        system: SYSTEM,
        messages: [{ role: "user", content: describe(input) }],
        output_config: { format: zodOutputFormat(outputSchema), ...(options.effort ? { effort: options.effort } : {}) },
      })
      if (response.stop_reason === "refusal") throw new Error("Il modello ha rifiutato la richiesta")
      if (response.stop_reason === "max_tokens") throw new Error("Risposta del modello troncata")
      if (!response.parsed_output) throw new Error("Risposta del modello non leggibile")
      return response.parsed_output.categories
    },
  }
}

/**
 * Keeps only known article ids, drops empty categories, and puts every article the model left out into
 * "Altre modifiche", so the summary never hides a change.
 */
export function normalizeCategories(categories: DiffCategory[], articles: ArticleChange[]): DiffCategory[] {
  const known = new Set(articles.map((a) => a.id))
  const out = categories
    .map((c) => ({
      title: c.title.trim().slice(0, 200),
      summary: c.summary.trim().slice(0, 2000),
      articleIds: [...new Set(c.articleIds.filter((id) => known.has(id)))],
    }))
    .filter((c) => c.title && (c.articleIds.length || c.summary))
  const covered = new Set(out.flatMap((c) => c.articleIds))
  const missing = articles.filter((a) => !covered.has(a.id))
  if (missing.length)
    out.push({
      title: "Altre modifiche",
      summary: `Altri articoli cambiati: ${missing.map((a) => (a.newLabel ?? a.oldLabel ?? a.id).split(" — ")[0]).join(", ")}.`,
      articleIds: missing.map((a) => a.id),
    })
  return out
}
