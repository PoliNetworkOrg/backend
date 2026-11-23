import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"
import { type RepoReader, readDocumentWith } from "@/regulations/compile/assets"
import { appendDocumentEntry, ManifestError, parseManifest } from "@/regulations/legal-source"
import { fillSkeleton, latexEscape, placementOf, TemplateError } from "@/regulations/templates"
import { SEARCH_PATH } from "@/regulations/worker/xelatex"

const encode = (text: string) => new TextEncoder().encode(text)

const manifest = {
  version: 2,
  templates: { generale: { title: "Documento generale", shared: "shared/generale/", skeleton: "templates/generale" } },
  documents: [
    {
      key: "guida",
      title: "Guida",
      dir: "generali/guida",
      entry: "guida.tex",
      sources: ["*.tex"],
      outputs: { pdf: "guida.pdf", markdown: "guida.md" },
      tagPrefix: "guida-",
      template: "generale",
      procedure: "documento",
    },
  ],
}

describe("documents.json v2", () => {
  it("parses templates and documents, trimming trailing slashes", () => {
    const parsed = parseManifest(JSON.stringify(manifest))
    expect(parsed.templates.generale.shared).toBe("shared/generale")
    expect(parsed.documents[0]).toMatchObject({ template: "generale", procedure: "documento" })
  })

  it("refuses a missing, malformed or v1 manifest with a message that says what is wrong", () => {
    const message = (text: string | null) => {
      try {
        parseManifest(text)
      } catch (error) {
        expect(error).toBeInstanceOf(ManifestError)
        return (error as Error).message
      }
      throw new Error("parsed")
    }
    expect(message(null)).toBe("documents.json non trovato nel repository dei documenti.")
    expect(message("{")).toBe("documents.json non è JSON valido.")
    expect(message(JSON.stringify({ version: 1, shared: "shared", documents: [] }))).toMatch(/\(version\)/)
    const doc = manifest.documents[0]
    expect(message(JSON.stringify({ ...manifest, documents: [doc, doc] }))).toMatch(/documents\.1\.key.*duplicate key/)
    expect(message(JSON.stringify({ ...manifest, documents: [{ ...doc, template: "x" }] }))).toMatch(/unknown template/)
    expect(message(JSON.stringify({ ...manifest, documents: [{ ...doc, procedure: "altro" }] }))).toMatch(/procedure/)
    expect(message(JSON.stringify({ ...manifest, documents: [{ ...doc, dir: "../fuori" }] }))).toMatch(/dir/)
    expect(message(JSON.stringify({ ...manifest, documents: [{ ...doc, outputs: {} }] }))).toMatch(/outputs\.pdf/)
  })
})

describe("appending to documents.json", () => {
  const entry = { key: "nuovo", sources: ["*.tex", "parti/*.tex"], outputs: { pdf: "nuovo.pdf" }, template: null }

  it("keeps the repository's formatting: the diff is only the new entry, arrays inline", () => {
    const text = [
      "{",
      '  "version": 2,',
      '  "templates": { "x": { "title": "X", "shared": "s", "skeleton": "k" } },',
      '  "documents": [',
      "    {",
      '      "key": "rri",',
      '      "sources": ["RRI.tex", "regolamenti/*.tex"]',
      "    }",
      "  ]",
      "}",
      "",
    ].join("\n")
    expect(appendDocumentEntry(text, entry)).toBe(
      [
        ...text.split("\n").slice(0, 7),
        "    },",
        "    {",
        '      "key": "nuovo",',
        '      "sources": ["*.tex", "parti/*.tex"],',
        '      "outputs": {',
        '        "pdf": "nuovo.pdf"',
        "      },",
        '      "template": null',
        "    }",
        "  ]",
        "}",
        "",
      ].join("\n")
    )
  })

  it("fills an empty list, and rewrites a layout it can't follow", () => {
    const empty = appendDocumentEntry('{\n  "version": 2,\n  "templates": {},\n  "documents": []\n}\n', entry)
    expect(JSON.parse(empty).documents).toEqual([entry])
    expect(empty).toContain('\n  "documents": [\n    {\n      "key": "nuovo",')
    const odd = '{"documents":[{"key":"a"}],"version":2}'
    expect(JSON.parse(appendDocumentEntry(odd, entry)).documents).toEqual([{ key: "a" }, entry])
    expect(() => appendDocumentEntry("{}", entry)).toThrow(/elenco dei documenti/)
  })
})

describe("asset bundles", () => {
  const tree: Record<string, string> = {
    "generali/guida/guida.tex": "\\documentclass{polinetwork}",
    "generali/guida/foto.png": "png",
    "generali/guida/guida.pdf": "built",
    "generali/guida/guida.aux": "aux",
    "generali/guida/latexmkrc": "rc",
    "shared/generale/polinetwork.cls": "cls",
    "shared/generale/fonts/DMSans-Regular.ttf": "ttf",
    "shared/generale/img/sub/logo.png": "logo",
    "shared/generale/.hidden": "x",
  }
  const reader: RepoReader = {
    list: async (dir) =>
      Object.keys(tree)
        .filter((p) => p.startsWith(`${dir}/`))
        .map((p) => p.slice(dir.length + 1)),
    read: async (path) => encode(tree[path]),
  }
  const layout = { dir: "generali/guida", entry: "guida.tex", sources: ["*.tex"], outputs: { pdf: "guida.pdf" } }

  it("carries the template's whole shared tree under shared/, fonts and nested images included", async () => {
    const { sources, assets } = await readDocumentWith(reader, { ...layout, shared: "shared/generale" })
    expect(Object.keys(sources)).toEqual(["guida.tex"])
    expect(Object.keys(assets.files).sort()).toEqual([
      "foto.png",
      "shared/fonts/DMSans-Regular.ttf",
      "shared/img/sub/logo.png",
      "shared/polinetwork.cls",
    ])
  })

  it("has no shared directory for a self-contained document", async () => {
    const { assets } = await readDocumentWith(reader, { ...layout, shared: null })
    expect(Object.keys(assets.files)).toEqual(["foto.png"])
  })

  it("compiles with the shared tree on TEXINPUTS, TTFONTS and OPENTYPEFONTS, then TeX Live's defaults", () => {
    expect(SEARCH_PATH).toBe(".:./shared//:")
  })
})

describe("templates", () => {
  it("fills the placeholders, escaping the title for LaTeX, and finds the main file", () => {
    const filled = fillSkeleton(
      {
        "{{KEY}}.tex": encode("\\documentclass{x}\\title{{{TITLE}}}\\date{{{DATE}}}{{KEY}}"),
        "parti/uno.tex": encode("{{TITLE}}"),
        "logo.png": new Uint8Array([1, 2]),
        latexmkrc: encode("rc"),
      },
      { title: "Soci & 100% {nuovi}_", key: "statuto-x", date: "2026-11-22" }
    )
    expect(filled.entry).toBe("statuto-x.tex")
    expect(filled.sources["statuto-x.tex"]).toBe(
      "\\documentclass{x}\\title{Soci \\& 100\\% \\{nuovi\\}\\_}\\date{2026-11-22}statuto-x"
    )
    expect(filled.sourceGlobs).toEqual(["*.tex", "parti/*.tex"])
    // latexmkrc is committed to the repository, but isn't a compile asset.
    expect(Object.keys(filled.assets)).toEqual(["logo.png"])
    expect(Object.keys(filled.commit).sort()).toEqual(["latexmkrc", "logo.png", "parti/uno.tex", "statuto-x.tex"])
  })

  it("refuses a skeleton without a single main file", () => {
    expect(() => fillSkeleton({ "a.tex": encode("x") }, { title: "T", key: "k", date: "d" })).toThrow(TemplateError)
    expect(() =>
      fillSkeleton(
        { "a.tex": encode("\\documentclass{x}"), "b.tex": encode("\\documentclass{y}") },
        { title: "T", key: "k", date: "d" }
      )
    ).toThrow(/più file principali/)
    expect(
      fillSkeleton(
        { "a.tex": encode("\\documentclass{x}"), "main.tex": encode("\\documentclass{y}") },
        { title: "T", key: "k", date: "d" }
      ).entry
    ).toBe("main.tex")
  })

  it("places regolamenti and general documents", () => {
    expect(placementOf("regolamento")).toBe("regolamenti")
    expect(placementOf("generale")).toBe("generali")
    expect(latexEscape("a\\b~c^d#e$")).toBe("a\\textbackslash{}b\\textasciitilde{}c\\textasciicircum{}d\\#e\\$")
  })
})

it.skipIf(!process.env.SEED_TEST_DB_PORT)(
  "runs documents beyond the RRI against PostgreSQL: v2 manifest, read-only, documento, private, uploads, creation",
  async () => {
    const { stdout } = await promisify(execFile)("bun", ["tests/regulations-documents.fixture.ts"], {
      env: process.env,
      timeout: 90_000,
    })
    const result = JSON.parse(
      stdout
        .trim()
        .split("\n")
        .findLast((line) => line.startsWith('{"checked"')) ?? "{}"
    )
    expect(result.checked).toHaveLength(13)
  },
  95_000
)
