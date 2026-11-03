import { sql } from "drizzle-orm"
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  customType,
  date,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core"
import type {
  ArticleChange,
  DeliberaBody,
  DraftKind,
  DraftRole,
  Files,
  PersonRef,
  StateKey,
} from "@/regulations/contract"
import { createTable } from "../create-table"

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "bytea",
  fromDriver: (value) => new Uint8Array(value),
})
const at = (name: string) => timestamp(name, { precision: 3, withTimezone: true, mode: "date" })

/** One document from the legal repository's `legal.json` (e.g. the RRI). */
export const documents = createTable.regulations("documents", {
  key: text().primaryKey(),
  title: text().notNull(),
  /** Directory in the legal repository, e.g. `rri`. */
  dir: text().notNull(),
  /** Entry file relative to `dir`, e.g. `RRI.tex`. */
  entry: text().notNull(),
  /** Globs (relative to `dir`) of the editable sources. */
  sources: jsonb().$type<string[]>().notNull(),
  /** Release asset names, e.g. `{ pdf: "RaccoltaRegolamentiInterni.pdf", markdown: "…md" }`. */
  outputs: jsonb().$type<Record<string, string>>().notNull(),
  tagPrefix: text("tag_prefix").notNull(),
  /** Procedure configuration key (see `regulations/procedure.ts`). */
  procedure: text().notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
  updatedAt: at("updated_at").notNull().defaultNow(),
})

/** A published (emanated or imported) version: the full editable sources at that point. */
export const versions = createTable.regulations(
  "versions",
  {
    id: text().primaryKey(),
    documentKey: text("document_key")
      .notNull()
      .references(() => documents.key),
    tag: text(),
    label: text().notNull(),
    files: jsonb().$type<Files>().notNull(),
    sourceHash: text("source_hash").notNull(),
    commitSha: text("commit_sha"),
    /** The draft it was emanated from; `null` for imports. */
    draftId: text("draft_id").references((): AnyPgColumn => drafts.id),
    publishedAt: at("published_at").notNull(),
    releaseUrl: text("release_url"),
    /** Hash in `regulations_blobs` of the official PDF, once downloaded or compiled. */
    pdfBlob: text("pdf_blob"),
    /**
     * Hash in `regulations_blobs` of the non-editable files the compile needs (fonts, the shared class, images),
     * as an asset bundle. Drafts compile with the assets of the version their lineage starts from.
     */
    assetsBlob: text("assets_blob"),
  },
  (t) => [
    index("regulations_versions_document_idx").on(t.documentKey, t.publishedAt),
    uniqueIndex("regulations_versions_tag_idx").on(t.documentKey, t.tag),
  ]
)

/** A working draft (tavolo di lavoro). Its live text is the Yjs document in `regulations_ydocs`. */
export const drafts = createTable.regulations(
  "drafts",
  {
    id: text().primaryKey(),
    documentKey: text("document_key")
      .notNull()
      .references(() => documents.key),
    title: text().notNull(),
    kind: text().$type<DraftKind>().notNull(),
    state: text().$type<StateKey>().notNull(),
    baseVersionId: text("base_version_id").references(() => versions.id),
    baseDraftId: text("base_draft_id").references((): AnyPgColumn => drafts.id),
    /** The text at fork time: the 3-way merge base against its parent. */
    baseFiles: jsonb("base_files").$type<Files>().notNull(),
    /** Text frozen when leaving `bozza`; what is approved and emanated. */
    frozenFiles: jsonb("frozen_files").$type<Files>(),
    /** From the last text the collab service saved. */
    parses: boolean(),
    createdBy: jsonb("created_by").$type<PersonRef>().notNull(),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
    stateChangedAt: at("state_changed_at").notNull(),
    approvedAt: at("approved_at"),
    emanatedAt: at("emanated_at"),
    notifiedAt: at("notified_at"),
    deletedAt: at("deleted_at"),
    deletedBy: jsonb("deleted_by").$type<PersonRef>(),
  },
  (t) => [
    index("regulations_drafts_document_idx").on(t.documentKey),
    // Only one draft per document may be in approval at a time.
    uniqueIndex("regulations_drafts_in_approval_idx")
      .on(t.documentKey)
      .where(sql`${t.state} = 'in_approvazione' and ${t.deletedAt} is null`),
    check("regulations_drafts_kind_check", sql`${t.kind} in ('modifica', 'rettifica')`),
    check("regulations_drafts_state_check", sql`${t.state} in ('bozza', 'in_approvazione', 'approvata', 'emanata')`),
    check("regulations_drafts_base_check", sql`(${t.baseVersionId} is null) <> (${t.baseDraftId} is null)`),
  ]
)

/** Per-draft access, Google-Docs style. */
export const assignments = createTable.regulations(
  "assignments",
  {
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    userSub: text("user_sub").notNull(),
    user: jsonb().$type<PersonRef>().notNull(),
    role: text().$type<DraftRole>().notNull(),
    assignedBy: jsonb("assigned_by").$type<PersonRef>().notNull(),
    assignedAt: at("assigned_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.draftId, t.userSub] }),
    index("regulations_assignments_user_idx").on(t.userSub),
    check("regulations_assignments_role_check", sql`${t.role} in ('editor', 'commenter', 'viewer')`),
  ]
)

/** Compacted Yjs state of a draft: one `Y.Text` per source file in `getMap("files")`. */
export const ydocs = createTable.regulations("ydocs", {
  draftId: text("draft_id")
    .primaryKey()
    .references(() => drafts.id),
  state: bytea().notNull(),
  /** The last update folded into `state`. */
  compactedThrough: bigint("compacted_through", { mode: "number" }).notNull().default(0),
  updatedAt: at("updated_at").notNull(),
})

/** Yjs updates since the last compaction, appended as they arrive so a crash loses nothing. */
export const yupdates = createTable.regulations(
  "yupdates",
  {
    id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    update: bytea().notNull(),
    actorSub: text("actor_sub"),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [index("regulations_yupdates_draft_idx").on(t.draftId, t.id)]
)

/** Single-use tickets for one collaborative connection. Only the hash is stored. */
export const collabTickets = createTable.regulations(
  "collab_tickets",
  {
    hash: text().primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    user: jsonb().$type<PersonRef>().notNull(),
    role: text().$type<DraftRole>().notNull(),
    readOnly: boolean("read_only").notNull(),
    expiresAt: at("expires_at").notNull(),
    usedAt: at("used_at"),
  },
  (t) => [index("regulations_collab_tickets_expiry_idx").on(t.expiresAt)]
)

export type SnapshotKind = "base" | "auto" | "named" | "state" | "restore" | "merge"

export const snapshots = createTable.regulations(
  "snapshots",
  {
    id: text().primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    kind: text().$type<SnapshotKind>().notNull(),
    name: text(),
    files: jsonb().$type<Files>().notNull(),
    sourceHash: text("source_hash").notNull(),
    createdBy: jsonb("created_by").$type<PersonRef>(),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("regulations_snapshots_draft_idx").on(t.draftId, t.createdAt),
    check("regulations_snapshots_kind_check", sql`${t.kind} in ('base', 'auto', 'named', 'state', 'restore', 'merge')`),
  ]
)

/** Threaded comments anchored to Yjs relative positions. Never exported. */
export const comments = createTable.regulations(
  "comments",
  {
    id: text().primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    /** `null` for the first comment of a thread. */
    parentId: text("parent_id").references((): AnyPgColumn => comments.id),
    file: text(),
    anchorStart: text("anchor_start"),
    anchorEnd: text("anchor_end"),
    quote: text(),
    body: text().notNull(),
    author: jsonb().$type<PersonRef>().notNull(),
    createdAt: at("created_at").notNull(),
    editedAt: at("edited_at"),
    resolvedAt: at("resolved_at"),
    resolvedBy: jsonb("resolved_by").$type<PersonRef>(),
    deletedAt: at("deleted_at"),
  },
  (t) => [
    index("regulations_comments_draft_idx").on(t.draftId, t.createdAt),
    check(
      "regulations_comments_anchor_check",
      sql`(${t.parentId} is null) = (${t.file} is not null and ${t.anchorStart} is not null and ${t.anchorEnd} is not null)`
    ),
  ]
)

/** The outcome recorded for a draft: an approval by a body, or a rectification. One per draft. */
export const delibere = createTable.regulations(
  "delibere",
  {
    draftId: text("draft_id")
      .primaryKey()
      .references(() => drafts.id),
    kind: text().$type<"approvazione" | "rettifica">().notNull(),
    body: text().$type<DeliberaBody>(),
    date: date({ mode: "string" }).notNull(),
    verbaleUrl: text("verbale_url"),
    recordedBy: jsonb("recorded_by").$type<PersonRef>().notNull(),
    recordedAt: at("recorded_at").notNull(),
    /** For a rettifica on a delega. */
    delegaId: text("delega_id").references((): AnyPgColumn => deleghe.id),
    onBehalfOf: jsonb("on_behalf_of").$type<PersonRef>(),
  },
  (t) => [
    check("regulations_delibere_kind_check", sql`${t.kind} in ('approvazione', 'rettifica')`),
    check(
      "regulations_delibere_body_check",
      sql`(${t.kind} = 'approvazione') = (${t.body} in ('consiglio_direttivo', 'assemblea'))`
    ),
  ]
)

export type DiffCategoryJson = { title: string; summary: string; articleIds: string[] }

/** LLM diffs: one row per generation; the highest generation is current. */
export const diffs = createTable.regulations(
  "diffs",
  {
    id: text().primaryKey(),
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    generation: integer().notNull(),
    status: text().$type<"pending" | "ready" | "failed">().notNull(),
    baseLabel: text("base_label").notNull(),
    articles: jsonb().$type<ArticleChange[]>().notNull(),
    otherChanges: jsonb("other_changes").$type<string[]>().notNull(),
    categories: jsonb().$type<DiffCategoryJson[]>(),
    provider: text(),
    model: text(),
    error: text(),
    /** Hash in `regulations_blobs` of the differences PDF. */
    pdfBlob: text("pdf_blob"),
    requestedBy: jsonb("requested_by").$type<PersonRef>(),
    createdAt: at("created_at").notNull(),
    finishedAt: at("finished_at"),
  },
  (t) => [
    uniqueIndex("regulations_diffs_generation_idx").on(t.draftId, t.generation),
    check("regulations_diffs_status_check", sql`${t.status} in ('pending', 'ready', 'failed')`),
  ]
)

/** Content-addressed files: compiled PDFs, differences PDFs, official PDFs. */
export const blobs = createTable.regulations("blobs", {
  hash: text().primaryKey(),
  contentType: text("content_type").notNull(),
  content: bytea().notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
})

/** Compile results cached by source hash, shared across drafts and viewers. */
export const compiles = createTable.regulations("compiles", {
  hash: text().primaryKey(),
  ok: boolean().notNull(),
  /** Hash in `regulations_blobs` of the PDF, when `ok`. */
  pdfBlob: text("pdf_blob"),
  errors: jsonb().$type<{ file: string | null; line: number | null; message: string }[]>().notNull(),
  log: text().notNull(),
  durationMs: integer("duration_ms").notNull(),
  createdAt: at("created_at").notNull().defaultNow(),
})

/** Compile state of each draft, as `compile.status` reports it. */
export const draftCompiles = createTable.regulations("draft_compiles", {
  draftId: text("draft_id")
    .primaryKey()
    .references(() => drafts.id),
  state: text().$type<"idle" | "queued" | "running" | "ok" | "error">().notNull(),
  hash: text(),
  lastGoodHash: text("last_good_hash"),
  compiledAt: at("compiled_at"),
  /** Why the latest compile couldn't run (e.g. the worker is unreachable); compile errors are in `compiles`. */
  error: text(),
  updatedAt: at("updated_at").notNull(),
})

/** Which source hashes were compiled for a draft: `compile.pdf` only serves those. */
export const compileRefs = createTable.regulations(
  "compile_refs",
  {
    draftId: text("draft_id")
      .notNull()
      .references(() => drafts.id),
    hash: text().notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.draftId, t.hash] })]
)

/** Merges applied to a draft. The source's text at the last merge is the base of the next one. */
export const merges = createTable.regulations(
  "merges",
  {
    id: text().primaryKey(),
    targetDraftId: text("target_draft_id")
      .notNull()
      .references(() => drafts.id),
    sourceKind: text("source_kind").$type<"draft" | "version">().notNull(),
    sourceId: text("source_id").notNull(),
    sourceFiles: jsonb("source_files").$type<Files>().notNull(),
    resolutions: jsonb().$type<Record<string, unknown>>().notNull(),
    mergedBy: jsonb("merged_by").$type<PersonRef>().notNull(),
    mergedAt: at("merged_at").notNull(),
  },
  (t) => [index("regulations_merges_pair_idx").on(t.targetDraftId, t.sourceKind, t.sourceId, t.mergedAt)]
)

export type EmanationStepKey = "pr" | "checks" | "merge" | "tag" | "release" | "email" | "telegram"
export type EmanationStepJson = {
  state: "pending" | "running" | "done" | "failed" | "skipped"
  url: string | null
  at: string | null
  detail: string | null
}

/** "Emana e notifica": PR → checks → merge → tag → release → email → Telegram. Resumable step by step. */
export const emanations = createTable.regulations(
  "emanations",
  {
    draftId: text("draft_id")
      .primaryKey()
      .references(() => drafts.id),
    status: text().$type<"running" | "waiting" | "done" | "failed">().notNull(),
    /** The generated sources, as committed. */
    files: jsonb().$type<Files>().notNull(),
    tag: text(),
    branch: text().notNull(),
    prNumber: integer("pr_number"),
    mergeSha: text("merge_sha"),
    releaseId: bigint("release_id", { mode: "number" }),
    versionId: text("version_id").references(() => versions.id),
    steps: jsonb().$type<Record<EmanationStepKey, EmanationStepJson>>().notNull(),
    attempts: integer().notNull().default(0),
    startedBy: jsonb("started_by").$type<PersonRef>().notNull(),
    startedAt: at("started_at").notNull(),
    nextCheckAt: at("next_check_at"),
    finishedAt: at("finished_at"),
  },
  (t) => [check("regulations_emanations_status_check", sql`${t.status} in ('running', 'waiting', 'done', 'failed')`)]
)

/** Every notification sent (or attempted), as proof: time and recipients. */
export const notifications = createTable.regulations(
  "notifications",
  {
    id: text().primaryKey(),
    /** Idempotency key, e.g. `emanation:<draftId>:email`. */
    key: text().notNull().unique(),
    draftId: text("draft_id").references(() => drafts.id),
    delegaId: text("delega_id").references((): AnyPgColumn => deleghe.id),
    channel: text().$type<"email" | "telegram">().notNull(),
    kind: text().notNull(),
    recipients: jsonb().$type<string[]>().notNull(),
    subject: text(),
    status: text().$type<"pending" | "sent" | "failed">().notNull(),
    attempts: integer().notNull().default(0),
    error: text(),
    createdAt: at("created_at").notNull(),
    sentAt: at("sent_at"),
  },
  (t) => [
    index("regulations_notifications_draft_idx").on(t.draftId),
    check("regulations_notifications_channel_check", sql`${t.channel} in ('email', 'telegram')`),
    check("regulations_notifications_status_check", sql`${t.status} in ('pending', 'sent', 'failed')`),
  ]
)

/** The Segretario's deleghe of rectification (Statuto, art. "Direttivo", comma 9). */
export const deleghe = createTable.regulations(
  "deleghe",
  {
    id: text().primaryKey(),
    granteeSub: text("grantee_sub").notNull(),
    grantee: jsonb().$type<PersonRef>().notNull(),
    documentKey: text("document_key").references(() => documents.key),
    expiresAt: at("expires_at"),
    note: text(),
    grantedBy: jsonb("granted_by").$type<PersonRef>().notNull(),
    createdAt: at("created_at").notNull(),
    revokedAt: at("revoked_at"),
    revokedBy: jsonb("revoked_by").$type<PersonRef>(),
  },
  (t) => [index("regulations_deleghe_grantee_idx").on(t.granteeSub)]
)

export const schema = {
  regulationsDocuments: documents,
  regulationsVersions: versions,
  regulationsDrafts: drafts,
  regulationsAssignments: assignments,
  regulationsYdocs: ydocs,
  regulationsYupdates: yupdates,
  regulationsCollabTickets: collabTickets,
  regulationsSnapshots: snapshots,
  regulationsComments: comments,
  regulationsDelibere: delibere,
  regulationsDiffs: diffs,
  regulationsBlobs: blobs,
  regulationsCompiles: compiles,
  regulationsDraftCompiles: draftCompiles,
  regulationsCompileRefs: compileRefs,
  regulationsMerges: merges,
  regulationsEmanations: emanations,
  regulationsNotifications: notifications,
  regulationsDeleghe: deleghe,
}
