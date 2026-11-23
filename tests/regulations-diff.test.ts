import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { renderDifferencesPdf } from "@/regulations/diff/pdf"
import { anthropicSummarizer, fakeSummarizer, normalizeCategories } from "@/regulations/diff/summarizer"
import { diffDocuments } from "@/regulations/latex"

const SAMPLE = (() => {
  const dir = join(import.meta.dirname, "fixtures/regulations/sample")
  const out: Record<string, string> = {}
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) visit(full)
      else out[relative(dir, full)] = readFileSync(full, "utf8")
    }
  }
  visit(dir)
  return out
})()
const changed = {
  ...SAMPLE,
  "parti/primo.tex": SAMPLE["parti/primo.tex"]
    .replace("a maggioranza semplice", "a maggioranza assoluta (⅔ dei presenti)")
    .replace("\\articolo[id=art001]{Scopo}\nIl presente regolamento disciplina le prove.\n\n", ""),
  "parti/secondo.tex": SAMPLE["parti/secondo.tex"].replace(
    "\\articolo[id=art102]{Sanzioni}",
    "\\articolo[id=art1n1]{Ricorsi}\nI ricorsi vanno al Collegio entro dieci giorni.\n\n\\articolo[id=art102]{Sanzioni}"
  ),
}
const diff = diffDocuments(SAMPLE, changed, "main.tex")
const input = {
  documentTitle: "Raccolta di prova",
  baseLabel: "v2026.10.08",
  articles: diff.articles,
  otherChanges: diff.otherChanges,
}

describe("diff summarizers", () => {
  it("the fake one groups by kind of change, deterministically", async () => {
    const categories = await fakeSummarizer().summarize(input)
    expect(categories.map((c) => c.title)).toEqual([
      "Nuovi articoli",
      "Articoli modificati",
      "Articoli abrogati",
      "Articoli spostati o rinumerati",
    ])
    expect(await fakeSummarizer().summarize(input)).toEqual(categories)
  })

  it("keeps only known articles and never hides one the model left out", () => {
    const out = normalizeCategories(
      [
        { title: "Maggioranze", summary: "Serve la maggioranza assoluta.", articleIds: ["art003", "nope", "art003"] },
        { title: "  ", summary: "", articleIds: [] },
      ],
      diff.articles
    )
    expect(out[0].articleIds).toEqual(["art003"])
    expect(out.at(-1)?.title).toBe("Altre modifiche")
    expect(new Set(out.flatMap((c) => c.articleIds))).toEqual(new Set(diff.articles.map((a) => a.id)))
  })

  it("asks Claude for structured output with the configured model", async () => {
    const calls: Record<string, unknown>[] = []
    const client = {
      messages: {
        parse: async (params: Record<string, unknown>) => {
          calls.push(params)
          return {
            stop_reason: "end_turn",
            parsed_output: { categories: [{ title: "Ricorsi", summary: "Nuovo termine.", articleIds: ["art1n1"] }] },
          }
        },
      },
    }
    const summarizer = anthropicSummarizer({
      apiKey: "x",
      model: "model-from-env",
      effort: "high",
      client: client as never,
    })
    expect(await summarizer.summarize(input)).toEqual([
      { title: "Ricorsi", summary: "Nuovo termine.", articleIds: ["art1n1"] },
    ])
    const params = calls[0] as {
      model: string
      output_config: { format: { type: string }; effort: string }
      messages: { content: string }[]
    }
    expect(params.model).toBe("model-from-env")
    expect(params.output_config.effort).toBe("high")
    expect(params.output_config.format.type).toBe("json_schema")
    expect(params.messages[0].content).toContain("id=art1n1 · added")
    client.messages.parse = async () => ({ stop_reason: "refusal", parsed_output: null }) as never
    await expect(summarizer.summarize(input)).rejects.toThrow(/rifiutato/)
  })
})

describe("differences PDF", () => {
  it("has a summary page and side-by-side pages for changed articles only", async () => {
    const bytes = await renderDifferencesPdf({
      ...input,
      newLabel: "sample-v2026.11.20",
      subtitle: "Approvato dal Consiglio Direttivo il 20/11/2026",
      categories: normalizeCategories(await fakeSummarizer().summarize(input), diff.articles),
      generatedAt: new Date("2026-11-20T10:00:00Z"),
    })
    const pdf = await PDFDocument.load(bytes)
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(2)
    expect(pdf.getTitle()).toBe("Differenze: Raccolta di prova")
  })
})
