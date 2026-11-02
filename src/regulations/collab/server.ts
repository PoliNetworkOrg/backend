import { timingSafeEqual } from "node:crypto"
import { type Document, Server } from "@hocuspocus/server"
import type { Logger } from "pino"
import * as Y from "yjs"
import type { CompileEvent } from "../compile/service"
import type { DraftRole, Files, PersonRef } from "../contract"
import type { RegulationsDb } from "../db"
import { type DraftContext, draftContext } from "../draft-context"
import { idEdits, parseDocument } from "../latex"
import { autoSnapshot, createYjsPersistence, setParses } from "./persistence"
import { consumeTicket } from "./tickets"
import { applyTextEdits, filesFromDoc, replaceFiles } from "./ydoc"

/**
 * The collaborative editing service (Hocuspocus), a separate entrypoint and pod. Each draft is one Yjs document
 * (name = draft id) with one `Y.Text` per source file. Connections authenticate with single-use tickets from
 * `regulations.collabTicket`; commenters and viewers, and everyone outside editable states, are read-only.
 *
 * While people type it inserts missing ids, records whether the text parses, and asks the compiler for a new PDF
 * about 1.5 s after the last edit. The backend drives it through an internal HTTP API (text, replace, freeze,
 * reopen, broadcast) on a port that is never exposed publicly.
 */

/** `writable`: the ticket allows editing (an editor's), whatever the draft's state. */
export type CollabContext = { user: PersonRef | null; role: DraftRole | "system"; writable: boolean }

export type CollabOptions = {
  db: RegulationsDb
  logger: Logger
  port: number
  internalPort: number
  /** Shared with the backend for the internal API. */
  internalSecret: string
  compiler?: { request: (job: { draftId: string; entry: string; assets: string; files: Files }) => Promise<string> }
  /** Delay after the last edit before ids, parse state and compile are refreshed. */
  idleMs?: number
  snapshotEveryMs?: number
}

const DRAFT_ID = /^[A-Za-z0-9_-]{8,40}$/
const SYSTEM: CollabContext = { user: null, role: "system", writable: true }

export async function startCollab(options: CollabOptions) {
  const { db, logger } = options
  const persistence = createYjsPersistence(db)
  const idleMs = options.idleMs ?? 1500
  const snapshotEveryMs = options.snapshotEveryMs ?? 10 * 60_000
  /** Drafts frozen by the backend: read-only for every connection until reopened. */
  const frozen = new Set<string>()
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const contexts = new Map<string, DraftContext>()

  const contextOf = async (draftId: string, refresh = false) => {
    const cached = contexts.get(draftId)
    if (cached && !refresh) return cached
    const context = await draftContext(db, draftId)
    if (context) contexts.set(draftId, context)
    return context
  }

  const server = new Server({
    name: "regulations-collab",
    port: options.port,
    quiet: true,
    debounce: 2000,
    maxDebounce: 10_000,
    timeout: 30_000,
    stopOnSignals: false,

    async onAuthenticate({ token, documentName, connectionConfig }) {
      if (!DRAFT_ID.test(documentName)) throw new Error("unauthorized")
      const ticket = await consumeTicket(db, token, documentName)
      if (!ticket) throw new Error("unauthorized")
      const draft = await contextOf(documentName, true)
      if (!draft || draft.deleted) throw new Error("unauthorized")
      const writable = !ticket.readOnly && ticket.role === "editor"
      connectionConfig.readOnly = !writable || !draft.editable || frozen.has(documentName)
      logger.info(
        { draftId: documentName, sub: ticket.user.id, role: ticket.role, readOnly: connectionConfig.readOnly },
        "[COLLAB] connected"
      )
      return { user: ticket.user, role: ticket.role, writable } satisfies CollabContext
    },

    async onLoadDocument({ document, documentName }) {
      const draft = await contextOf(documentName, true)
      if (!draft || draft.deleted) throw new Error("not found")
      const state = await persistence.load(documentName)
      if (state) Y.applyUpdate(document, state)
      else replaceFiles(document, draft.baseFiles)
      return document
    },

    async afterLoadDocument({ documentName }) {
      schedule(documentName, 0)
    },

    async onChange({ documentName, update, context }) {
      const ctx = (context ?? SYSTEM) as CollabContext
      await persistence.append(documentName, update, ctx.user?.id ?? null)
      schedule(documentName, idleMs)
    },

    async onStoreDocument({ documentName, document }) {
      await persistence.compact(documentName, Y.encodeStateAsUpdate(document))
      await autoSnapshot(db, documentName, filesFromDoc(document), snapshotEveryMs).catch((err) =>
        logger.error({ err, draftId: documentName }, "[COLLAB] auto snapshot failed")
      )
    },

    async afterUnloadDocument({ documentName }) {
      clearTimeout(timers.get(documentName))
      timers.delete(documentName)
      contexts.delete(documentName)
    },
  })

  function schedule(draftId: string, delay: number) {
    clearTimeout(timers.get(draftId))
    timers.set(
      draftId,
      setTimeout(() => {
        timers.delete(draftId)
        idle(draftId).catch((err) => logger.error({ err, draftId }, "[COLLAB] idle work failed"))
      }, delay)
    )
  }

  /** After a pause: insert missing ids (editable drafts only), record whether the text parses, compile. */
  async function idle(draftId: string) {
    const draft = await contextOf(draftId)
    if (!draft) return
    const files = await withDocument(draftId, (doc) => {
      if (draft.editable && !frozen.has(draftId)) {
        const edits = idEdits(parseDocument(filesFromDoc(doc), draft.entry))
        applyTextEdits(doc, edits)
      }
      return filesFromDoc(doc)
    })
    const parsed = parseDocument(files, draft.entry)
    await setParses(db, draftId, parsed.parses)
    if (options.compiler && draft.assetsHash)
      await options.compiler.request({ draftId, entry: draft.entry, assets: draft.assetsHash, files })
  }

  /** Runs `fn` on the live document, loading it if no one has it open. */
  async function withDocument<T>(draftId: string, fn: (doc: Document) => T): Promise<T> {
    const connection = await server.hocuspocus.openDirectConnection(draftId, SYSTEM)
    let result: T | undefined
    try {
      await connection.transact((doc) => {
        result = fn(doc)
      })
    } finally {
      await connection.disconnect()
    }
    return result as T
  }

  const broadcast = (draftId: string, message: Record<string, unknown>) =>
    server.hocuspocus.documents.get(draftId)?.broadcastStateless(JSON.stringify(message))

  function onCompileEvent(event: CompileEvent) {
    broadcast(event.draftId, { type: "compile", hash: event.hash, state: event.state })
  }

  // ---- internal API (backend only) ----
  const authorized = (req: Request) => {
    const given = Buffer.from(req.headers.get("authorization") ?? "")
    const expected = Buffer.from(`Bearer ${options.internalSecret}`)
    return given.length === expected.length && timingSafeEqual(given, expected)
  }
  const internal = Bun.serve({
    port: options.internalPort,
    maxRequestBodySize: 16 * 1024 * 1024,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/health")
        return Response.json({
          ok: true,
          documents: server.hocuspocus.getDocumentsCount(),
          connections: server.hocuspocus.getConnectionsCount(),
        })
      if (!authorized(req)) return Response.json({ error: "unauthorized" }, { status: 401 })
      const match = /^\/drafts\/([A-Za-z0-9_-]{8,40})\/(text|replace|freeze|reopen|broadcast|refresh)$/.exec(
        url.pathname
      )
      if (!match || req.method !== "POST") return Response.json({ error: "not found" }, { status: 404 })
      const [, draftId, action] = match
      try {
        const draft = await contextOf(draftId, true)
        if (!draft) return Response.json({ error: "no such draft" }, { status: 404 })
        switch (action) {
          case "text":
            return Response.json({ files: await withDocument(draftId, (doc) => filesFromDoc(doc)) })
          case "replace": {
            const body = (await req.json()) as { files: Files }
            const files = await withDocument(draftId, (doc) => {
              replaceFiles(doc, body.files)
              return filesFromDoc(doc)
            })
            schedule(draftId, 0)
            return Response.json({ files })
          }
          case "freeze": {
            // Ids first (the frozen text is what gets approved), then every connection becomes read-only.
            const files = await withDocument(draftId, (doc) => {
              applyTextEdits(doc, idEdits(parseDocument(filesFromDoc(doc), draft.entry)))
              return filesFromDoc(doc)
            })
            frozen.add(draftId)
            for (const connection of server.hocuspocus.documents.get(draftId)?.getConnections() ?? [])
              connection.readOnly = true
            broadcast(draftId, { type: "state", state: draft.state })
            return Response.json({ files, parses: parseDocument(files, draft.entry).parses })
          }
          case "reopen": {
            frozen.delete(draftId)
            // Editors' connections become writable again in place, if the draft is editable.
            for (const connection of server.hocuspocus.documents.get(draftId)?.getConnections() ?? [])
              connection.readOnly = !(connection.context as CollabContext).writable || !draft.editable
            broadcast(draftId, { type: "state", state: draft.state })
            return Response.json({ ok: true })
          }
          case "broadcast": {
            broadcast(draftId, (await req.json()) as Record<string, unknown>)
            return Response.json({ ok: true })
          }
          case "refresh":
            schedule(draftId, 0)
            return Response.json({ ok: true })
        }
        return Response.json({ error: "not found" }, { status: 404 })
      } catch (err) {
        logger.error({ err, draftId, action }, "[COLLAB] internal request failed")
        return Response.json({ error: "internal error" }, { status: 500 })
      }
    },
  })

  await server.listen()
  logger.info({ port: server.address.port, internalPort: internal.port }, "[COLLAB] listening")

  return {
    server,
    internal,
    onCompileEvent,
    /** Port actually bound (useful with port 0 in tests). */
    get port() {
      return server.address.port
    },
    async stop() {
      for (const t of timers.values()) clearTimeout(t)
      internal.stop(true)
      await server.destroy()
    },
  }
}
