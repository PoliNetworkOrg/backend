import { z } from "zod"

/**
 * Wire contract of the documents editor (`regulations.*`), shared with the admin dashboard (PoliNetworkOrg/admin),
 * which keeps a copy of this file. Keep input/output changes coordinated with that repository.
 *
 * It covers every PoliNetwork document, not only the regulations: the documents of the repository (its
 * `documents.json`), with the procedure each one declares, and the private documents kept only in the backend.
 *
 * Dates and instants are ISO 8601 strings: `YYYY-MM-DD` for calendar dates (a delibera), full timestamps otherwise.
 * People are IdP accounts, identified by their subject (`id`).
 */

/** IdP permissions (PoliNetwork Auth). Per-draft access is backend data, not IdP roles. */
export const REGULATION_PERMISSIONS = {
  /** See documents (private ones included), versions and every draft (as a viewer). */
  read: "regulations:read",
  /** Create drafts, assign members, edit any draft, merge, send to approval. */
  write: "regulations:write",
  /**
   * Record the approval, emanate, regenerate the LLM diff, publish a `documento` draft, create documents (repository
   * or private) and upload PDFs.
   */
  manage: "regulations:manage",
  /** Rectify (rettifica) and manage deleghe. */
  rectify: "regulations:rectify",
} as const

export const personRefSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable() })
export type PersonRef = z.infer<typeof personRefSchema>

export const draftIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/)
export const documentKeySchema = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/)

// ---------------------------------------------------------------------------------------------------------------------
// Procedure (configuration per document type)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The states a procedure may use. A document type picks its own subset, transitions and deadlines:
 * - `rri`: bozza → in_approvazione → approvata → emanata (rettifica: bozza → emanata);
 * - `documento`: bozza → pubblicata.
 * `emanata` and `pubblicata` are final: the draft became a published version.
 */
export const STATE_KEYS = ["bozza", "in_approvazione", "approvata", "emanata", "pubblicata"] as const
export const stateKeySchema = z.enum(STATE_KEYS)
export type StateKey = z.infer<typeof stateKeySchema>
/** A draft in one of these states is closed: it is a published version now. */
export const FINAL_STATES = ["emanata", "pubblicata"] as const satisfies readonly StateKey[]
/** Drafts still on their way (counted as open, listed by default). */
export const OPEN_STATES = ["bozza", "in_approvazione", "approvata"] as const satisfies readonly StateKey[]

/**
 * The procedure a document declares in `documents.json`:
 * - `rri`: the Raccolta dei Regolamenti Interni's (delibera, LLM differences, Soci notice, rettifica, deleghe);
 * - `documento`: bozza → pubblicata, published by `regulations:manage`, no delibera, no LLM, no notice.
 * A document without a procedure (`null`) is read-only ("sola consultazione").
 */
export const PROCEDURE_KEYS = ["rri", "documento"] as const
export const procedureKeySchema = z.enum(PROCEDURE_KEYS)
export type ProcedureKey = z.infer<typeof procedureKeySchema>

/**
 * - `modifica`: the ordinary path (bozza → in_approvazione → approvata → emanata; bozza → pubblicata for `documento`);
 * - `rettifica`: typos with no change of meaning; skips `approvata` and is emanated by the Segretario or a delegate.
 *   Only for documents with the `rri` procedure.
 */
export const DRAFT_KINDS = ["modifica", "rettifica"] as const
export const draftKindSchema = z.enum(DRAFT_KINDS)
export type DraftKind = z.infer<typeof draftKindSchema>

export const procedureSchema = z.object({
  key: procedureKeySchema,
  states: z.array(
    z.object({
      key: stateKeySchema,
      label: z.string(),
      /** Whether the text can be edited in this state. */
      editable: z.boolean(),
    })
  ),
  transitions: z.array(
    z.object({
      from: stateKeySchema,
      to: stateKeySchema,
      label: z.string(),
      /** The draft kinds this transition applies to. */
      kinds: z.array(draftKindSchema),
    })
  ),
  deadlines: z.array(
    z.object({
      key: z.string(),
      label: z.string(),
      days: z.number().int(),
      /** `warning`: something must happen before it; `info`: shown for information only. */
      severity: z.enum(["warning", "info"]),
    })
  ),
})
export type Procedure = z.infer<typeof procedureSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Me, users
// ---------------------------------------------------------------------------------------------------------------------

/** `regulations.me.get`: callable by any signed-in dashboard account, with no permission. */
export const meSchema = z.object({
  /** Drafts (not deleted) the account is assigned to. Admits people without `admin:access` to the dashboard. */
  assignedDrafts: z.number().int(),
  /** Active deleghe held by the account (rectification on behalf of the Segretario). */
  deleghe: z.number().int(),
  permissions: z.object({ read: z.boolean(), write: z.boolean(), manage: z.boolean(), rectify: z.boolean() }),
  /**
   * Documents the caller may rectify (only `rri` procedure documents): every one with `regulations:rectify`, the scope
   * of their active deleghe otherwise. Lets a delegate without `regulations:read` start a rettifica from the latest
   * version.
   */
  rectifiable: z.array(
    z.object({
      documentKey: z.string(),
      title: z.string(),
      latestVersionId: z.string().nullable(),
      latestVersionLabel: z.string().nullable(),
    })
  ),
})
export type Me = z.infer<typeof meSchema>

export const userSearchInputSchema = z.object({ q: z.string().trim().min(2).max(80) })
/** Any IdP account (not only Soci). */
export const userMatchSchema = z.object({ id: z.string(), name: z.string(), email: z.string().nullable() })
export type UserMatch = z.infer<typeof userMatchSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Documents and published versions
// ---------------------------------------------------------------------------------------------------------------------

export const DELIBERA_BODIES = ["consiglio_direttivo", "assemblea"] as const
export const deliberaBodySchema = z.enum(DELIBERA_BODIES)
export type DeliberaBody = z.infer<typeof deliberaBodySchema>

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** How a version came to be: an approval by a body, or a rectification by the Segretario (or a delegate). */
export const deliberaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approvazione"),
    body: deliberaBodySchema,
    date: isoDate,
    verbaleUrl: z.string().nullable(),
    recordedBy: personRefSchema,
    recordedAt: z.string(),
  }),
  z.object({
    kind: z.literal("rettifica"),
    date: isoDate,
    /** Who emanated the rectification. */
    rectifiedBy: personRefSchema,
    /** Set when acting on a delega: the Segretario who granted it ("Rettificato da X su delega del Segretario"). */
    onBehalfOf: personRefSchema.nullable(),
    delegaId: z.string().nullable(),
  }),
])
export type Delibera = z.infer<typeof deliberaSchema>

/**
 * Where a version comes from:
 * - `import`: imported from the repository (first import, or the repository's head for a read-only document);
 * - `draft`: emanated or published from a draft (`draftId`);
 * - `template`: the starting text of a private document created from a template;
 * - `upload`: an uploaded PDF (private, read-only documents).
 */
export const VERSION_ORIGINS = ["import", "draft", "template", "upload"] as const
export const versionOriginSchema = z.enum(VERSION_ORIGINS)
export type VersionOrigin = z.infer<typeof versionOriginSchema>

export const versionSummarySchema = z.object({
  id: z.string(),
  documentKey: z.string(),
  /** Git tag on the documents repository, e.g. `rri-v2026.10.08`; `null` for imports and private documents. */
  tag: z.string().nullable(),
  /** e.g. "v2026.10.08", or the tag/commit it was imported from. */
  label: z.string(),
  origin: versionOriginSchema,
  /** `null` for versions imported from the repository and for `documento` publications. */
  delibera: deliberaSchema.nullable(),
  publishedAt: z.string(),
  releaseUrl: z.string().nullable(),
  /** Whether `versions.pdf` can serve its PDF (official, uploaded, or compiled on demand). */
  pdfAvailable: z.boolean(),
  /** The draft it was emanated or published from. */
  draftId: z.string().nullable(),
})
export type VersionSummary = z.infer<typeof versionSummarySchema>

/**
 * How the dashboard groups documents:
 * - `regolamento`: procedure `rri`, or a document made from the `regolamento` template;
 * - `generale`: any other repository document with a procedure (Documenti generali);
 * - `privato`: kept only in the backend (never on GitHub, the LLM, email or Telegram);
 * - `consultazione`: a repository document without a procedure (Statuto, Regolamento Elettorale): read-only.
 */
export const DOCUMENT_KINDS = ["regolamento", "generale", "privato", "consultazione"] as const
export const documentKindSchema = z.enum(DOCUMENT_KINDS)
export type DocumentKind = z.infer<typeof documentKindSchema>

/** `repo`: in the documents repository on GitHub; `private`: only in the backend's database. */
export const DOCUMENT_STORAGES = ["repo", "private"] as const
export const documentStorageSchema = z.enum(DOCUMENT_STORAGES)
export type DocumentStorage = z.infer<typeof documentStorageSchema>

/** `latex`: sources compiled to PDF; `upload`: an uploaded PDF, read-only (a new version is a new upload). */
export const DOCUMENT_ORIGINS = ["latex", "upload"] as const
export const documentOriginSchema = z.enum(DOCUMENT_ORIGINS)
export type DocumentOrigin = z.infer<typeof documentOriginSchema>

/**
 * - `active`: usable;
 * - `creating`: a repository document whose pull request (from `documents.create`) hasn't merged yet ("in creazione");
 * - `failed`: that pull request failed or was closed: see `creation.error`; `documents.create` with the same key
 *   tries again.
 */
export const DOCUMENT_STATUSES = ["active", "creating", "failed"] as const
export const documentStatusSchema = z.enum(DOCUMENT_STATUSES)

export const documentCreationSchema = z.object({
  /** The pull request on the documents repository. */
  prNumber: z.number().int().nullable(),
  prUrl: z.string().nullable(),
  /** Why it failed, in Italian, or `null`. */
  error: z.string().nullable(),
  startedAt: z.string(),
  startedBy: personRefSchema,
})

export const documentSchema = z.object({
  key: z.string(),
  title: z.string(),
  kind: documentKindSchema,
  storage: documentStorageSchema,
  origin: documentOriginSchema,
  /** Template key in `documents.json` (`regolamento`, `generale`), or `null` (self-contained, uploaded). */
  template: z.string().nullable(),
  /** `null`: sola consultazione. */
  procedureKey: procedureKeySchema.nullable(),
  /** The procedure's states and transitions; `null` for sola consultazione. */
  procedure: procedureSchema.nullable(),
  /** Drafts can be created: a LaTeX document with a procedure, `active`. */
  editable: z.boolean(),
  status: documentStatusSchema,
  /** For a repository document created from the dashboard, until it's active. */
  creation: documentCreationSchema.nullable(),
  /** Tag prefix on the repository; meaningless for private documents. */
  tagPrefix: z.string(),
  latestVersion: versionSummarySchema.nullable(),
  /** Drafts not yet emanated, published or deleted. */
  openDrafts: z.number().int(),
  /** The only draft that may be `in_approvazione` at a time (`rri` only). */
  inApproval: z.object({ id: z.string(), title: z.string() }).nullable(),
})
export type DocumentInfo = z.infer<typeof documentSchema>

/** `documents.sync`: what the import from the repository did. */
export const syncResultSchema = z.object({
  /** Every document of the manifest that was imported or updated. */
  documents: z.array(z.string()),
  /** Documents imported for the first time (their first version). */
  imported: z.array(z.string()),
  /** Read-only documents whose sources changed in the repository: a new version from its head. */
  updated: z.array(z.string()),
  /** Left as they are, with the reason (e.g. the key is a private document's, or open drafts block a change). */
  skipped: z.array(z.object({ key: z.string(), reason: z.string() })),
})
export type SyncResult = z.infer<typeof syncResultSchema>

/** A template of `documents.json`: the starting files and the shared class of new documents. */
export const templateSchema = z.object({
  key: z.string(),
  title: z.string(),
  /** Parent directory of a new repository document, e.g. `regolamenti/` (it goes in `regolamenti/<key>/`). */
  directory: z.string(),
})
export type TemplateInfo = z.infer<typeof templateSchema>

/**
 * `documents.create` (`regulations:manage`): a new document from a template.
 * - `repo`: the GitHub App opens a pull request adding `<directory>/` from the template's skeleton and the manifest
 *   entry (procedure `documento`); it auto-merges after CI. The document is listed as `creating` until then.
 * - `private`: the skeleton and the template's shared files are copied from the repository now and kept only in the
 *   backend; procedure `documento`. Its first version (origin `template`) is the starting text: create a draft from it.
 * The key is unique across repository and private documents.
 */
export const createDocumentInputSchema = z.object({
  key: documentKeySchema,
  title: z.string().trim().min(1).max(120),
  template: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  storage: documentStorageSchema,
})
export type CreateDocumentInput = z.output<typeof createDocumentInputSchema>

/** The largest PDF `documents.upload` and `versions.upload` accept. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/**
 * `documents.upload` (`regulations:manage`), sent as `FormData`: `key`, `title`, `file` (a PDF up to 20 MB). Creates a
 * private, read-only document (origin `upload`) with the file as its first version.
 */
export const uploadDocumentFieldsSchema = z.object({
  key: documentKeySchema,
  title: z.string().trim().min(1).max(120),
})
/** `versions.upload` (`regulations:manage`), sent as `FormData`: `documentKey`, `file`. A new version of an upload. */
export const uploadVersionFieldsSchema = z.object({ documentKey: documentKeySchema })

/** Source files by path, relative to the document's directory (e.g. `regolamenti/2_interno.tex`). */
export const filesSchema = z.record(z.string(), z.string())
export type Files = z.infer<typeof filesSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Structure (derived by the parser)
// ---------------------------------------------------------------------------------------------------------------------

export const NODE_KINDS = ["documento", "regolamento", "capo", "articolo", "comma", "lettera"] as const
export const nodeKindSchema = z.enum(NODE_KINDS)
export type NodeKind = z.infer<typeof nodeKindSchema>

export type StructureNode = {
  /** Stable id (lowercase base36, 6 chars); lettere get `<commaId>.<n>`, the root `documento`. */
  id: string
  kind: NodeKind
  /** Recomputed from order: "2", "2.3", "2.3.1"; commi "3", lettere "b". `null` for the root. */
  number: string | null
  /** e.g. "Articolo 2.3", "comma 4", "lettera b)". */
  label: string
  title: string | null
  file: string
  /** UTF-16 offsets in `file`, as CodeMirror and Y.Text count. */
  range: { start: number; end: number }
  children: StructureNode[]
}
export const structureNodeSchema: z.ZodType<StructureNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: nodeKindSchema,
    number: z.string().nullable(),
    label: z.string(),
    title: z.string().nullable(),
    file: z.string(),
    range: z.object({ start: z.number().int(), end: z.number().int() }),
    children: z.array(structureNodeSchema),
  })
)

export const validationIssueSchema = z.object({
  file: z.string(),
  /** 1-based. */
  line: z.number().int(),
  /** 1-based, in UTF-16 code units. */
  column: z.number().int(),
  offset: z.number().int(),
  endOffset: z.number().int(),
  severity: z.enum(["error", "warning"]),
  code: z.string(),
  message: z.string(),
})
export type ValidationIssue = z.infer<typeof validationIssueSchema>

export const structureSchema = z.object({
  /** No `error` issues: state transitions and merges are allowed. */
  parses: z.boolean(),
  tree: structureNodeSchema,
  issues: z.array(validationIssueSchema),
})
export type Structure = z.infer<typeof structureSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------------------------------------------------

export const DRAFT_ROLES = ["editor", "commenter", "viewer"] as const
export const draftRoleSchema = z.enum(DRAFT_ROLES)
export type DraftRole = z.infer<typeof draftRoleSchema>

export const draftBaseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("version"), id: z.string(), label: z.string() }),
  z.object({ kind: z.literal("draft"), id: z.string(), title: z.string() }),
])
export type DraftBase = z.infer<typeof draftBaseSchema>

export const draftSummarySchema = z.object({
  id: z.string(),
  documentKey: z.string(),
  title: z.string(),
  kind: draftKindSchema,
  state: stateKeySchema,
  base: draftBaseSchema,
  /**
   * The caller's effective role: `regulations:write` is always `editor`, `regulations:read` at least `viewer`. In a
   * secret draft only the creator (`editor`) and the members they add, with the role they were given.
   */
  myRole: draftRoleSchema,
  /**
   * A secret draft: only its creator and the members they add see it, and its procedure is closed until the creator
   * makes it visible to `regulations:read` (`drafts.reveal`), for good.
   */
  secret: z.boolean(),
  createdBy: personRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  stateChangedAt: z.string(),
  /** From the last saved text; `null` until first parsed. */
  parses: z.boolean().nullable(),
})
export type DraftSummary = z.infer<typeof draftSummarySchema>

export const deadlineSchema = z.object({
  key: z.string(),
  label: z.string(),
  dueAt: z.string(),
  severity: z.enum(["warning", "info"]),
  /** For `warning`: past due and the expected step has not happened. */
  overdue: z.boolean(),
})
export type Deadline = z.infer<typeof deadlineSchema>

export const transitionOptionSchema = z.object({
  to: stateKeySchema,
  label: z.string(),
  /** Required input, e.g. the delibera for `approvata`. */
  requires: z.array(z.enum(["delibera"])),
  /** Why the caller can't take it right now (e.g. the text doesn't parse), or `null`. */
  blockedBy: z.string().nullable(),
})

export const capabilitiesSchema = z.object({
  /** Writable collaborative session (editor, editable state, no emanation running). */
  edit: z.boolean(),
  comment: z.boolean(),
  assign: z.boolean(),
  /** Merge another draft or a version into this one. */
  merge: z.boolean(),
  /** Transitions the caller may take now (emanation has its own action). */
  transitions: z.array(transitionOptionSchema),
  /** Record the approval (`approvata`) with the delibera. */
  approve: z.boolean(),
  /**
   * `emanation.start` now: "Emana e notifica" (`rri`), "Emana rettifica", or "Pubblica" (`documento`). The label is
   * the procedure's transition to the final state.
   */
  emanate: z.boolean(),
  /**
   * Why the caller, who could otherwise emanate in this state, can't right now (e.g. a superseded base, text that
   * doesn't parse, missing differences), or `null`. `null` too when emanation isn't an option at all.
   */
  emanateBlockedBy: z.string().nullable(),
  /** The caller may emanate rettifiche of this document (permission or delega). */
  rectify: z.boolean(),
  regenerateDiff: z.boolean(),
  delete: z.boolean(),
  rename: z.boolean(),
  snapshot: z.boolean(),
  restore: z.boolean(),
  /** Make the secret draft visible (`drafts.reveal`): its creator only. */
  reveal: z.boolean(),
})
export type Capabilities = z.infer<typeof capabilitiesSchema>

export const DIFF_STATUSES = ["none", "pending", "ready", "failed"] as const

export const draftSchema = draftSummarySchema.extend({
  can: capabilitiesSchema,
  procedure: procedureSchema,
  deadlines: z.array(deadlineSchema),
  delibera: deliberaSchema.nullable(),
  diffStatus: z.enum(DIFF_STATUSES),
  emanationStatus: z.enum(["none", "running", "waiting", "done", "failed"]),
  /** The version published from this draft. */
  versionId: z.string().nullable(),
  approvedAt: z.string().nullable(),
  emanatedAt: z.string().nullable(),
  notifiedAt: z.string().nullable(),
})
export type Draft = z.infer<typeof draftSchema>

export const draftRefInputSchema = z.object({ draftId: draftIdSchema })

export const createDraftInputSchema = z.object({
  documentKey: documentKeySchema,
  title: z.string().trim().min(1).max(120),
  from: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("version"), id: z.string().min(1) }),
    z.object({ kind: z.literal("draft"), id: draftIdSchema }),
  ]),
  kind: draftKindSchema.default("modifica"),
  /** Start it secret. A draft from a secret draft is always secret. */
  secret: z.boolean().default(false),
})
export const renameDraftInputSchema = z.object({ draftId: draftIdSchema, title: z.string().trim().min(1).max(120) })
export const listDraftsInputSchema = z.object({
  documentKey: documentKeySchema.optional(),
  /** Include emanated and published drafts. */
  includeClosed: z.boolean().default(false),
})

export const draftFilesSchema = z.object({
  files: filesSchema,
  structure: structureSchema,
  /** The document's source globs (documents.json `sources`): where a draft may add files. Empty: anywhere. */
  sources: z.array(z.string()),
})

export const transitionInputSchema = z.object({
  draftId: draftIdSchema,
  to: stateKeySchema,
  /** Required for `approvata`. */
  delibera: z
    .object({
      body: deliberaBodySchema,
      date: isoDate,
      verbaleUrl: z.url().max(500).nullish(),
    })
    .optional(),
})

// ---------------------------------------------------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------------------------------------------------

export const assignmentSchema = z.object({
  user: personRefSchema,
  role: draftRoleSchema,
  assignedBy: personRefSchema,
  assignedAt: z.string(),
})
export type Assignment = z.infer<typeof assignmentSchema>

export const setAssignmentInputSchema = z.object({
  draftId: draftIdSchema,
  userId: z.string().min(1),
  role: draftRoleSchema,
})
export const removeAssignmentInputSchema = z.object({ draftId: draftIdSchema, userId: z.string().min(1) })

// ---------------------------------------------------------------------------------------------------------------------
// Collaboration (Hocuspocus)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * `regulations.collabTicket`: a single-use ticket for one Hocuspocus connection, bound to one draft and one role,
 * valid for `expiresAt` (about a minute). Pass it as the provider's `token`, and give the provider a function that asks
 * for a new ticket, since a reconnect needs a fresh one.
 *
 * Y.Doc layout: the Hocuspocus document name is the draft id; `ydoc.getMap("files")` maps each source path to its
 * `Y.Text`. Stateless messages from the server are JSON, e.g. `{ "type": "compile", "hash", "state" }` and
 * `{ "type": "state", "state" }` (the draft changed state; ask for a new ticket and reconnect).
 */
export const collabTicketSchema = z.object({
  url: z.string(),
  documentName: z.string(),
  ticket: z.string(),
  role: draftRoleSchema,
  /** Text is read-only for commenters and viewers, and for everyone outside editable states. */
  readOnly: z.boolean(),
  expiresAt: z.string(),
})
export type CollabTicket = z.infer<typeof collabTicketSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Compile (PDF preview)
// ---------------------------------------------------------------------------------------------------------------------

export const COMPILE_STATES = ["idle", "queued", "running", "ok", "error"] as const
export const compileErrorSchema = z.object({
  file: z.string().nullable(),
  line: z.number().int().nullable(),
  message: z.string(),
})
export const compileStatusSchema = z.object({
  state: z.enum(COMPILE_STATES),
  /** Source hash of the latest text sent to the compiler. */
  hash: z.string().nullable(),
  /** Hash of the last successful PDF: keep showing it when the latest compile fails. */
  lastGoodHash: z.string().nullable(),
  compiledAt: z.string().nullable(),
  errors: z.array(compileErrorSchema),
  /** Tail of the xelatex log for the latest compile. */
  log: z.string().nullable(),
})
export type CompileStatus = z.infer<typeof compileStatusSchema>

/** A file served through tRPC (the browser can't reach the backend; the admin proxies it). */
export const binaryFileSchema = z.object({ fileName: z.string(), contentType: z.string(), base64: z.string() })
export type BinaryFile = z.infer<typeof binaryFileSchema>

export const compilePdfInputSchema = z.object({ draftId: draftIdSchema, hash: z.string().regex(/^[a-f0-9]{64}$/) })

// ---------------------------------------------------------------------------------------------------------------------
// Snapshots (history)
// ---------------------------------------------------------------------------------------------------------------------

export const SNAPSHOT_KINDS = ["base", "auto", "named", "state", "restore", "merge"] as const
export const snapshotSchema = z.object({
  id: z.string(),
  draftId: z.string(),
  kind: z.enum(SNAPSHOT_KINDS),
  /** Set for `named`; a description for the others (e.g. "In approvazione"). */
  name: z.string().nullable(),
  createdAt: z.string(),
  /** `null` for automatic snapshots. */
  createdBy: personRefSchema.nullable(),
})
export type Snapshot = z.infer<typeof snapshotSchema>
export const snapshotWithFilesSchema = snapshotSchema.extend({ files: filesSchema })
export const createSnapshotInputSchema = z.object({ draftId: draftIdSchema, name: z.string().trim().min(1).max(120) })
export const snapshotRefInputSchema = z.object({ snapshotId: z.string().min(1) })

// ---------------------------------------------------------------------------------------------------------------------
// Comments (tRPC, not Yjs: a commenter's connection is read-only)
// ---------------------------------------------------------------------------------------------------------------------

/** Base64 of `Y.encodeRelativePosition` for `start` and `end` in the file's `Y.Text`. */
export const anchorSchema = z.object({
  file: z.string().min(1).max(200),
  start: z.string().min(1).max(500),
  end: z.string().min(1).max(500),
})

export const commentSchema = z.object({
  id: z.string(),
  body: z.string(),
  author: personRefSchema,
  createdAt: z.string(),
  editedAt: z.string().nullable(),
  /** Deleted comments keep their place in a thread with an empty body. */
  deleted: z.boolean(),
})
export const commentThreadSchema = commentSchema.extend({
  draftId: z.string(),
  anchor: anchorSchema,
  /** The text at creation, for anchors whose text was deleted. */
  quote: z.string(),
  resolvedAt: z.string().nullable(),
  resolvedBy: personRefSchema.nullable(),
  replies: z.array(commentSchema),
})
export type CommentThread = z.infer<typeof commentThreadSchema>

export const createCommentInputSchema = z.object({
  draftId: draftIdSchema,
  anchor: anchorSchema,
  quote: z.string().max(2000),
  body: z.string().trim().min(1).max(5000),
})
export const replyCommentInputSchema = z.object({
  commentId: z.string().min(1),
  body: z.string().trim().min(1).max(5000),
})
export const commentRefInputSchema = z.object({ commentId: z.string().min(1) })

// ---------------------------------------------------------------------------------------------------------------------
// Merge (3-way per structure node)
// ---------------------------------------------------------------------------------------------------------------------

export const mergeSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("draft"), id: draftIdSchema }),
  z.object({ kind: z.literal("version"), id: z.string().min(1) }),
])
export const mergeInputSchema = z.object({ targetDraftId: draftIdSchema, source: mergeSourceSchema })

export const CONFLICT_TYPES = ["both_modified", "modified_deleted", "deleted_modified", "both_added"] as const
export const mergeConflictSchema = z.object({
  /** Structure node id (a comma is the smallest unit). */
  nodeId: z.string(),
  kind: nodeKindSchema,
  /** In the target ("ours") numbering when present, else the source's. */
  label: z.string(),
  file: z.string(),
  type: z.enum(CONFLICT_TYPES),
  /** LaTeX of the node's own text (a comma's whole text; an article's heading and body before its commi). */
  base: z.string().nullable(),
  ours: z.string().nullable(),
  theirs: z.string().nullable(),
})
export type MergeConflict = z.infer<typeof mergeConflictSchema>

export const mergePreviewSchema = z.object({
  /** Why the merge can't run (a side doesn't parse, ids missing, the target is frozen), or `null`. */
  blockedBy: z.string().nullable(),
  /** What the merge is computed against, e.g. "v2026.10.08" or "Bozza X al 12/10 (ultimo merge)". */
  baseLabel: z.string(),
  conflicts: z.array(mergeConflictSchema),
  /** Node ids changed by the source that apply cleanly. */
  applied: z.array(
    z.object({ nodeId: z.string(), label: z.string(), change: z.enum(["added", "removed", "modified", "moved"]) })
  ),
  /** Non-blocking notes, e.g. both sides reordered the same articles. */
  warnings: z.array(z.string()),
})
export type MergePreview = z.infer<typeof mergePreviewSchema>

export const conflictResolutionSchema = z.union([
  z.literal("ours"),
  z.literal("theirs"),
  z.object({ text: z.string().max(100_000) }),
])
export const applyMergeInputSchema = mergeInputSchema.extend({
  /** One per conflict, by `nodeId`. */
  resolutions: z.record(z.string(), conflictResolutionSchema),
})

// ---------------------------------------------------------------------------------------------------------------------
// Diff (structural + LLM categories)
// ---------------------------------------------------------------------------------------------------------------------

export const ARTICLE_CHANGE_KINDS = ["added", "removed", "modified", "moved", "renumbered"] as const
export const wordDiffSchema = z.array(z.object({ op: z.enum(["equal", "insert", "delete"]), text: z.string() }))

export const articleChangeSchema = z.object({
  /** Article id (stable across versions). */
  id: z.string(),
  kind: z.enum(ARTICLE_CHANGE_KINDS),
  /** e.g. "Articolo 2.3 — Team e Helper"; `null` when added/removed. */
  oldLabel: z.string().nullable(),
  newLabel: z.string().nullable(),
  /** Plain text (LaTeX rendered), with commi as numbered paragraphs. */
  oldText: z.string().nullable(),
  newText: z.string().nullable(),
  /** Word-level changes from `oldText` to `newText`; empty when unchanged. */
  words: wordDiffSchema,
  /** For a modified article that also moved: where from and to. */
  moved: z.object({ from: z.string(), to: z.string() }).nullable(),
})
export type ArticleChange = z.infer<typeof articleChangeSchema>

export const diffCategorySchema = z.object({ title: z.string(), summary: z.string(), articleIds: z.array(z.string()) })

export const diffSchema = z.object({
  status: z.enum(DIFF_STATUSES),
  /** 1 for the first generation, +1 for each regeneration. */
  generation: z.number().int(),
  generatedAt: z.string().nullable(),
  generatedBy: personRefSchema.nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  error: z.string().nullable(),
  /** Compared against. */
  baseLabel: z.string(),
  categories: z.array(diffCategorySchema),
  articles: z.array(articleChangeSchema),
  /** Changes outside articles (preamble, free LaTeX), as short descriptions. */
  otherChanges: z.array(z.string()),
  /** Regeneration is allowed until notification. */
  locked: z.boolean(),
})
export type Diff = z.infer<typeof diffSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Emanation
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Steps of `emanation.start`. A repository `documento` runs pr → release and skips the notices; a private one is
 * published in the database at once (every step `skipped`, status `done`).
 */
export const EMANATION_STEPS = ["pr", "checks", "merge", "tag", "release", "email", "telegram"] as const
export const emanationStepSchema = z.object({
  key: z.enum(EMANATION_STEPS),
  state: z.enum(["pending", "running", "done", "failed", "skipped"]),
  url: z.string().nullable(),
  at: z.string().nullable(),
  detail: z.string().nullable(),
})
export const notificationSchema = z.object({
  channel: z.enum(["email", "telegram"]),
  kind: z.string(),
  recipients: z.array(z.string()),
  status: z.enum(["pending", "sent", "failed"]),
  sentAt: z.string().nullable(),
  error: z.string().nullable(),
})
export const emanationSchema = z.object({
  draftId: z.string(),
  /** `waiting`: on GitHub (checks, merge, release); `failed`: a step failed, `emanation.retry` resumes. */
  status: z.enum(["running", "waiting", "done", "failed"]),
  tag: z.string().nullable(),
  steps: z.array(emanationStepSchema),
  startedAt: z.string(),
  startedBy: personRefSchema,
  finishedAt: z.string().nullable(),
  notifications: z.array(notificationSchema),
})
export type Emanation = z.infer<typeof emanationSchema>

// ---------------------------------------------------------------------------------------------------------------------
// Deleghe
// ---------------------------------------------------------------------------------------------------------------------

export const delegaSchema = z.object({
  id: z.string(),
  grantee: personRefSchema,
  /** `null`: every document. */
  documentKey: z.string().nullable(),
  expiresAt: z.string().nullable(),
  note: z.string().nullable(),
  grantedBy: personRefSchema,
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  revokedBy: personRefSchema.nullable(),
  active: z.boolean(),
})
export type Delega = z.infer<typeof delegaSchema>
export const createDelegaInputSchema = z.object({
  userId: z.string().min(1),
  /** An `rri` procedure document, or none for all of them. */
  documentKey: documentKeySchema.nullish(),
  expiresAt: z.iso.datetime({ offset: true }).nullish(),
  note: z.string().trim().max(500).nullish(),
})
export const delegaRefInputSchema = z.object({ delegaId: z.string().min(1) })

// ---------------------------------------------------------------------------------------------------------------------
// Input types (parsed)
// ---------------------------------------------------------------------------------------------------------------------

export type CreateDraftInput = z.output<typeof createDraftInputSchema>
export type TransitionInput = z.output<typeof transitionInputSchema>
export type CreateCommentInput = z.output<typeof createCommentInputSchema>
export type MergeSource = z.output<typeof mergeSourceSchema>
export type ApplyMergeInput = z.output<typeof applyMergeInputSchema>
export type CreateDelegaInput = z.output<typeof createDelegaInputSchema>
