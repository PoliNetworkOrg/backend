# Documents

The `regulations.*` router manages every PoliNetwork document, not only the Raccolta dei Regolamenti Interni (RRI).
The wire contract is `src/regulations/contract.ts`, of which the admin dashboard keeps a copy.

## Sources

- **Repository documents** come from `documents.json` (version 2) at the root of the documents repository,
  `REGULATIONS_GITHUB_REPO` (PoliNetworkOrg/documents, formerly `legal`). The backend reads it through the GitHub App, or
  from a local checkout with `REGULATIONS_LEGAL_DIR`. A missing or invalid manifest makes `documents.sync` fail with a
  message saying what is wrong. There is no fallback to the old `legal.json`.
- **Private documents** are only in the backend's database: never on GitHub, never sent to the LLM, by email or to
  Telegram.

## Kinds

| Kind (`documents.list`) | What | Procedure | Drafts |
| --- | --- | --- | --- |
| `regolamento` | procedure `rri`, or made from the `regolamento` template | `rri` or `documento` | yes |
| `generale` | any other repository document with a procedure | `documento` | yes |
| `privato` | from a template (`origin: latex`) or an uploaded PDF (`origin: upload`) | `documento` / none | LaTeX only |
| `consultazione` | repository document with `procedure: null` (Statuto, Regolamento Elettorale) | none | no |

- **`rri`**: bozza → in approvazione → approvata → emanata, delibera, LLM differences, Soci notice, rettifica and deleghe.
- **`documento`**: bozza → pubblicata, published by `regulations:manage` with `emanation.start` ("Pubblica"). No
  delibera, no LLM differences, no notice. A repository document goes through the App exactly like an emanation
  (pull request, auto-merge after CI, tag `<tagPrefix>vYYYY.MM.DD` dated the day it was published, release); the
  email and Telegram steps are `skipped`. A private one is published at once in the database: the version keeps its
  sources, the assets of its lineage and the PDF compiled by the worker (a text that doesn't compile is refused), and
  every emanation step is `skipped`. Drafts, merges, history and comments work as for the RRI; rettifiche don't exist.
- **Sola consultazione**: `documents.sync` imports the repository's head as a version (sources and assets, the PDF
  compiled by the worker on demand), and imports it again when the sources change in the repository. Every mutation
  refuses it.

Reading needs `regulations:read` (private documents included). Creating documents and uploading PDFs needs
`regulations:manage`, which the policy of `documents.create`, `documents.upload` and `versions.upload` carries too.

## Templates and the compile

`documents.json` has a `templates` map: each template has a `shared` directory (class, `.sty`, fonts, images) and a
`skeleton` (the starting files of a new document, with `{{TITLE}}`, `{{KEY}}` and `{{DATE}}` placeholders in `.tex`
files; `{{KEY}}` also in file names). A document's `template` is a key of that map, or `null` (self-contained).

A document's asset bundle is everything in its directory that isn't a source, a build product, `latexmkrc` or one of its
outputs, plus the whole tree of its template's `shared` directory under `shared/`. The worker keeps the paths: `shared/`
sits next to the entry file, and xelatex runs with `TEXINPUTS`, `TTFONTS` and `OPENTYPEFONTS` set to `.:./shared//:`
(the workdir, the shared tree recursively, then TeX Live's defaults), so classes load fonts by file name. The sandbox is
unchanged (`-no-shell-escape`, `openin_any=p`, `openout_any=p`, no network, read-only root, limits). Relinking a warm
workdir to another bundle removes the previous bundle's files first.

When the repository's shared files or a document's assets change, `documents.sync` and the boot-time refresh point the
document's latest version at the new bundle (an imported version's PDF is dropped and compiled again).

## New documents

`documents.create` takes `key` (slug, unique across repository and private documents), `title`, `template` and
`storage`:

- **`private`**: the skeleton (placeholders filled, the title escaped for LaTeX, the date as `YYYY-MM-DD`) and the
  template's shared tree are copied from the repository now. The document gets a first version, origin `template`
  ("Modello"): create a draft from it.
- **`repo`**: the App commits `regolamenti/<key>/` (template `regolamento`) or `generali/<key>/` (any other) from the
  skeleton, plus the new entry appended to `documents.json` at the pull request's base (procedure `documento`), opens a
  pull request and enables auto-merge. The document is listed with `status: "creating"` and `creation.prUrl` until it
  merges (webhook, or the reconciliation every `REGULATIONS_RECONCILE_SECONDS`); then it is `active` with the committed
  sources as its first version. A failed CI keeps it `creating` with `creation.error` (fix the pull request, or close it);
  a closed pull request or a commit that fails makes it `failed`, and `documents.create` with the same key starts again.
  A key whose tag prefix (`<key>-`) would be confused with another repository document's is refused, since the release
  workflow tells documents apart by it.

`documents.upload` (`FormData`: `key`, `title`, `file`) creates a private, read-only document from a PDF (at most 20 MB,
checked by its `%PDF-` header); `versions.upload` (`documentKey`, `file`) adds a new version. `versions.pdf` serves the
PDF of any version: official, uploaded, or compiled.

## Data

Migration `0040_regulations_documents`: `regulations_documents` gains `storage`, `origin`, `template`, `status`,
`creation` and a nullable `procedure`; `regulations_versions` gains `origin` (versions emanated from a draft become
`draft`); drafts may be `pubblicata`.
