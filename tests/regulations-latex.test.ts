import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import type { Files } from "@/regulations/contract"
import {
  applyDelibera,
  diffDocuments,
  ensureIds,
  merge3,
  parseDocument,
  refLabel,
  roundTrip,
  structureOf,
  walk,
} from "@/regulations/latex"

function readTree(dir: string, filter = (path: string) => path.endsWith(".tex")): Files {
  const out: Files = {}
  const visit = (d: string) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) visit(full)
      else if (filter(full)) out[relative(dir, full)] = readFileSync(full, "utf8")
    }
  }
  visit(dir)
  return out
}

const SAMPLE = readTree(join(import.meta.dirname, "fixtures/regulations/sample"))
const ENTRY = "main.tex"
const edit = (files: Files, path: string, from: string, to: string): Files => {
  const text = files[path]
  if (!text.includes(from)) throw new Error(`"${from}" not in ${path}`)
  return { ...files, [path]: text.replace(from, to) }
}
const labels = (files: Files) => {
  const doc = parseDocument(files, ENTRY)
  return Object.fromEntries([...walk(doc.tree)].map((n) => [n.id, n.label]))
}

describe("parser", () => {
  it("builds the structure tree across included files, numbered from order", () => {
    const doc = parseDocument(SAMPLE, ENTRY)
    expect(doc.issues).toEqual([])
    expect(doc.parses).toBe(true)
    expect(doc.order).toEqual(["main.tex", "parti/primo.tex", "parti/collegio.tex", "parti/secondo.tex"])
    const l = labels(SAMPLE)
    expect(l).toMatchObject({
      reg001: "Regolamento 1",
      art001: "Articolo 1.1",
      art002: "Articolo 1.2",
      cap001: "Capo 1.3",
      art003: "Articolo 1.3.1",
      com003: "comma 3",
      "com003.b": "lettera b)",
      art004: "Articolo 1.3.2",
      // An included file joins the tree where it is \input: inside the capo.
      cap002: "Capo 1.3.3",
      art006: "Articolo 1.3.3.1",
      art005: "Articolo 1.4",
      reg002: "Regolamento 2",
      art102: "Articolo 2.2",
    })
    expect(doc.nodes.get("cap002")?.file).toBe("parti/collegio.tex")
    expect(refLabel(doc, "art004")).toBe("articolo 1.3.2")
    expect(refLabel(doc, "com005")).toBe("articolo 1.3.2 comma 2")
  })

  it("serializes back to the exact text", () => {
    expect(roundTrip(SAMPLE, ENTRY)).toEqual(SAMPLE)
  })

  it("reports problems with positions instead of failing", () => {
    const broken = {
      ...SAMPLE,
      "parti/secondo.tex": [
        "\\regolamento[id=reg002]{Regolamento dei gruppi}",
        "\\articolo[id=ABC]{Gruppi}",
        "\\comma Fuori dai commi",
        "\\begin{commi}",
        "  \\comma[id=com101] Vedi \\rif{zzzzzz}.",
        "\\articolo[id=art001]{Doppio}",
        "",
      ].join("\n"),
    }
    const s = structureOf(broken, ENTRY)
    expect(s.parses).toBe(false)
    const found = s.issues.map((i) => [i.code, i.file, i.line, i.severity])
    expect(found).toEqual(
      expect.arrayContaining([
        ["invalid_id", "parti/secondo.tex", 2, "error"],
        ["misplaced", "parti/secondo.tex", 3, "error"],
        ["missing_id", "parti/secondo.tex", 3, "error"],
        ["unknown_ref", "parti/secondo.tex", 5, "error"],
        ["unclosed_env", "parti/secondo.tex", 4, "error"],
        ["duplicate_id", "parti/secondo.tex", 6, "error"],
      ])
    )
    const ref = s.issues.find((i) => i.code === "unknown_ref")
    expect(ref?.column).toBe(26)
    expect(broken["parti/secondo.tex"].slice(ref?.offset, ref?.endOffset)).toBe("\\rif{zzzzzz}")
  })

  it("assigns missing and duplicate ids, which nobody types", () => {
    const typed = edit(
      edit(
        SAMPLE,
        "parti/secondo.tex",
        "\\articolo[id=art102]{Sanzioni}",
        "\\articolo{Nuovo}\nTesto.\n\n\\articolo[id=art101]{Copia}"
      ),
      "parti/primo.tex",
      "\\comma[id=com002]",
      "\\comma Nuovo comma.\n  \\comma[note=x]"
    )
    const before = parseDocument(typed, ENTRY)
    expect(before.parses).toBe(false)
    let seed = 0
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280
      return seed / 233280
    }
    const { files, edits } = ensureIds(typed, ENTRY, random)
    expect(edits).toHaveLength(4)
    const after = parseDocument(files, ENTRY)
    expect(after.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(files["parti/primo.tex"]).toMatch(/\\comma\[id=[0-9a-z]{6},note=x\]/)
    expect(files["parti/secondo.tex"]).toMatch(/\\articolo\[id=[0-9a-z]{6}\]\{Nuovo\}/)
    // The first art101 keeps its id; the later copy gets a new one.
    expect(files["parti/secondo.tex"]).toContain("\\articolo[id=art101]{Gruppi}")
    expect(files["parti/secondo.tex"]).not.toContain("\\articolo[id=art101]{Copia}")
  })
})

describe("3-way merge", () => {
  const base = SAMPLE
  it("merges changes to different commi and articles automatically", () => {
    const ours = edit(
      base,
      "parti/primo.tex",
      "convocata dal Presidente",
      "convocata dal Presidente con 7 giorni di preavviso"
    )
    const theirs = edit(
      edit(base, "parti/primo.tex", "i due terzi dei presenti", "i tre quarti dei presenti"),
      "parti/secondo.tex",
      "\\articolo[id=art102]{Sanzioni}",
      "\\articolo[id=art1n1]{Ricorsi}\nI ricorsi vanno al Collegio.\n\n\\articolo[id=art102]{Sanzioni}"
    )
    const result = merge3({ base, ours, theirs, entry: ENTRY })
    expect(result.blockedBy).toBeNull()
    expect(result.conflicts).toEqual([])
    expect(result.files["parti/primo.tex"]).toContain("7 giorni di preavviso")
    expect(result.files["parti/primo.tex"]).toContain("tre quarti")
    expect(labels(result.files)).toMatchObject({ art1n1: "Articolo 2.2", art102: "Articolo 2.3" })
    expect(result.applied.map((a) => [a.nodeId, a.change])).toEqual(
      expect.arrayContaining([
        ["com004", "modified"],
        ["art1n1", "added"],
      ])
    )
  })

  it("reports the same comma changed on both sides as a conflict, resolved per node", () => {
    const o = edit(base, "parti/collegio.tex", "tre membri", "cinque membri")
    const t = edit(base, "parti/collegio.tex", "tre membri", "sette membri")
    const preview = merge3({ base, ours: o, theirs: t, entry: ENTRY })
    expect(preview.conflicts).toHaveLength(1)
    expect(preview.conflicts[0]).toMatchObject({ nodeId: "com006", type: "both_modified", file: "parti/collegio.tex" })
    expect(preview.conflicts[0].label).toBe("Articolo 1.3.3.1 (Composizione), comma 1")
    expect(preview.unresolved).toEqual(["com006"])
    expect(
      merge3({ base, ours: o, theirs: t, entry: ENTRY }, { com006: "theirs" }).files["parti/collegio.tex"]
    ).toContain("sette")
    const custom = merge3(
      { base, ours: o, theirs: t, entry: ENTRY },
      { com006: { text: "\\comma[id=com006] Il Collegio è composto da sei membri.\n  " } }
    )
    expect(custom.unresolved).toEqual([])
    expect(custom.files["parti/collegio.tex"]).toContain("sei membri")
    expect(parseDocument(custom.files, ENTRY).parses).toBe(true)
  })

  it("flags a deletion against a modification, and keeps the parent of a kept comma", () => {
    const ours = edit(base, "parti/primo.tex", "le prove.", "le prove e i collaudi.")
    const theirs = edit(
      base,
      "parti/primo.tex",
      "\\articolo[id=art001]{Scopo}\nIl presente regolamento disciplina le prove.\n\n",
      ""
    )
    const result = merge3({ base, ours, theirs, entry: ENTRY })
    expect(result.conflicts.map((c) => [c.nodeId, c.type])).toEqual([["art001", "modified_deleted"]])
    expect(merge3({ base, ours, theirs, entry: ENTRY }, { art001: "theirs" }).files["parti/primo.tex"]).not.toContain(
      "{Scopo}"
    )
    // A whole article deleted on one side while the other changed one of its commi.
    const o2 = edit(base, "parti/collegio.tex", "tre anni", "quattro anni")
    const t3 = {
      ...base,
      "parti/collegio.tex": base["parti/collegio.tex"].replace(/\\articolo\[id=art006\][\s\S]*?\\end\{commi\}\n/, ""),
    }
    const r2 = merge3({ base, ours: o2, theirs: t3, entry: ENTRY }, { com007: "ours" })
    expect(r2.conflicts.map((c) => [c.nodeId, c.type])).toEqual([["com007", "modified_deleted"]])
    expect(r2.files["parti/collegio.tex"]).toContain("quattro anni")
    expect(r2.files["parti/collegio.tex"]).not.toContain("tre membri")
    expect(r2.warnings.join(" ")).toContain("Articolo 1.3.3.1")
    expect(parseDocument(r2.files, ENTRY).parses).toBe(true)
  })

  it("follows a move made on one side and an edit made on the other", () => {
    const article =
      "\\articolo[id=art005]{Disposizioni finali}\nIl presente regolamento entra in vigore con la sua emanazione.\n"
    const moved = edit(
      edit(base, "parti/primo.tex", article, ""),
      "parti/primo.tex",
      "\\articolo[id=art002]{Notifiche}",
      `${article}\n\\articolo[id=art002]{Notifiche}`
    )
    const ours = edit(base, "parti/primo.tex", "entra in vigore", "entra in vigore il giorno dopo")
    const result = merge3({ base, ours, theirs: moved, entry: ENTRY })
    expect(result.conflicts).toEqual([])
    expect(labels(result.files).art005).toBe("Articolo 1.2")
    expect(result.files["parti/primo.tex"]).toContain("il giorno dopo")
    expect(result.applied).toContainEqual(expect.objectContaining({ nodeId: "art005", change: "moved" }))
  })

  it("refuses to merge text that does not parse", () => {
    const ours = edit(base, "parti/primo.tex", "\\end{commi}\n\n\\articolo[id=art004]", "\n\\articolo[id=art004]")
    expect(merge3({ base, ours, theirs: base, entry: ENTRY }).blockedBy).toMatch(/non è valido/)
  })
})

describe("structural diff", () => {
  it("classifies articles as added, removed, modified, moved and renumbered", () => {
    let next = edit(SAMPLE, "parti/primo.tex", "a maggioranza semplice", "a maggioranza assoluta")
    next = edit(
      next,
      "parti/primo.tex",
      "\\articolo[id=art001]{Scopo}\nIl presente regolamento disciplina le prove.\n\n",
      ""
    )
    next = edit(
      next,
      "parti/secondo.tex",
      "\\articolo[id=art101]{Gruppi}",
      "\\articolo[id=art100]{Definizioni}\nAdmin: chi modera.\n\n\\articolo[id=art101]{Gruppi}"
    )
    const diff = diffDocuments(SAMPLE, next, ENTRY)
    const kinds = Object.fromEntries(diff.articles.map((a) => [a.id, a.kind]))
    expect(kinds).toMatchObject({
      art001: "removed",
      art002: "renumbered",
      art003: "modified",
      art100: "added",
      art101: "renumbered",
    })
    const art003 = diff.articles.find((a) => a.id === "art003")
    expect(art003?.oldLabel).toBe("Articolo 1.3.1 — Assemblea")
    expect(art003?.newLabel).toBe("Articolo 1.2.1 — Assemblea")
    expect(art003?.newText).toContain(
      "2. L'Assemblea delibera a maggioranza assoluta, salvo quanto previsto dal articolo 1.2.2."
    )
    expect(art003?.newText).toContain("   b) gli ospiti invitati dal Direttivo.")
    expect(art003?.words.filter((w) => w.op !== "equal").map((w) => w.text)).toEqual(
      expect.arrayContaining(["semplice", "assoluta"])
    )
    expect(diff.articles.map((a) => a.id).indexOf("art001")).toBe(0)
  })

  it("detects a moved article and changes outside articles", () => {
    const article =
      "\\articolo[id=art005]{Disposizioni finali}\nIl presente regolamento entra in vigore con la sua emanazione.\n"
    let next = edit(SAMPLE, "parti/primo.tex", article, "")
    next = edit(
      next,
      "parti/secondo.tex",
      "\\articolo[id=art102]{Sanzioni}",
      `${article}\n\\articolo[id=art102]{Sanzioni}`
    )
    next = edit(next, "parti/primo.tex", "{Organi}", "{Organi sociali}")
    next = edit(next, "main.tex", "\\section*{Fine}", "\\section*{Fine della raccolta}")
    const diff = diffDocuments(SAMPLE, next, ENTRY)
    expect(diff.articles.find((a) => a.id === "art005")).toMatchObject({
      kind: "moved",
      moved: { from: "Articolo 1.4", to: "Articolo 2.2" },
    })
    expect(diff.otherChanges).toEqual(
      expect.arrayContaining([
        "Capo 1.3: titolo cambiato da «Organi» a «Organi sociali»",
        "Modificato il testo fuori dagli articoli in main.tex",
      ])
    )
  })
})

describe("delibera", () => {
  it("sets the approval and adds or replaces a rectification", () => {
    const approved = applyDelibera(SAMPLE, ENTRY, { kind: "approvazione", body: "assemblea", date: "2026-11-20" })
    expect(approved[ENTRY]).toContain("\\approvazione{assemblea}{2026-11-20}\n")
    const rectified = applyDelibera(approved, ENTRY, { kind: "rettifica", date: "2026-11-22", delegate: "Anna & Co" })
    expect(rectified[ENTRY]).toContain("\\approvazione{assemblea}{2026-11-20}\n\\rettifica[Anna \\& Co]{2026-11-22}\n")
    const again = applyDelibera(rectified, ENTRY, { kind: "rettifica", date: "2026-11-23", delegate: null })
    expect(again[ENTRY].match(/\\rettifica/g)).toHaveLength(1)
    expect(again[ENTRY]).toContain("\\rettifica{2026-11-23}")
    const reapproved = applyDelibera(again, ENTRY, {
      kind: "approvazione",
      body: "consiglio_direttivo",
      date: "2026-12-01",
    })
    expect(reapproved[ENTRY]).not.toContain("\\rettifica")
    expect(reapproved[ENTRY]).toContain("\\approvazione{direttivo}{2026-12-01}")
    expect(parseDocument(reapproved, ENTRY).parses).toBe(true)
  })
})

// The real RRI, from a local clone of PoliNetworkOrg/legal (private, so not a fixture of this public repository).
const legal = process.env.REGULATIONS_LEGAL_DIR
describe.skipIf(!legal)("the real RRI (REGULATIONS_LEGAL_DIR)", () => {
  it("parses without errors and serializes back to the same text", () => {
    const files = readTree(join(legal as string, "rri/latex"), (p) => p.endsWith(".tex") && !p.includes("/Old/"))
    const doc = parseDocument(files, "RRI.tex")
    expect(doc.issues.filter((i) => i.severity === "error")).toEqual([])
    expect(roundTrip(files, "RRI.tex")).toEqual(files)
    expect([...walk(doc.tree)].filter((n) => n.kind === "articolo").length).toBeGreaterThan(50)

    // Two drafts change different commi of the real text: they merge cleanly, and the diff finds both articles.
    const commi = [...walk(doc.tree)].filter((n) => n.kind === "comma" && n.parsed.id)
    const change = (node: (typeof commi)[number], files: Files) => {
      const text = files[node.file]
      const at = node.parsed.headerEnd
      return { ...files, [node.file]: `${text.slice(0, at)} MODIFICATO${text.slice(at)}` }
    }
    const [first, last] = [commi[3], commi[commi.length - 3]]
    const merged = merge3({ base: files, ours: change(first, files), theirs: change(last, files), entry: "RRI.tex" })
    expect(merged.conflicts).toEqual([])
    expect(merged.files).toEqual(change(last, change(first, files)))
    const diff = diffDocuments(files, merged.files, "RRI.tex")
    expect(diff.articles.map((a) => a.kind)).toEqual(["modified", "modified"])
    expect(diff.otherChanges).toEqual([])
  })
})
