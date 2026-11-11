import { beforeEach, expect, it, vi } from "vitest"
import { auditRecorder } from "@/audit"

const state = vi.hoisted(() => ({
  projects: { id: Symbol("id"), title: Symbol("title"), order: Symbol("order") },
  rows: [] as { id: number; title: string; order: number }[],
}))
vi.mock("drizzle-orm", async (importOriginal) => ({
  ...(await importOriginal<typeof import("drizzle-orm")>()),
  asc: (column: unknown) => column,
  eq: (_column: unknown, id: number) => id,
}))
vi.mock("@/azure/blob", () => ({ uploadBlob: vi.fn() }))
vi.mock("@/utils/web", () => ({ getImageExtension: vi.fn() }))
vi.mock("@/db", () => {
  const tx = {
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        orderBy: async () =>
          [...state.rows]
            .sort((a, b) => a.order - b.order)
            .map((row) => Object.fromEntries(Object.keys(fields).map((key) => [key, row[key as keyof typeof row]]))),
      }),
    }),
    update: () => ({
      set: ({ order }: { order: number }) => ({
        where: (id: number) => ({
          returning: async () => {
            const row = state.rows.find((row) => row.id === id)
            if (!row) return []
            row.order = order
            return [{ id }]
          },
        }),
      }),
    }),
  }
  return {
    DB: { transaction: (run: (tx: unknown) => unknown) => run(tx) },
    SCHEMA: { WEB: { projects: state.projects } },
  }
})
vi.mock("@/trpc", () => {
  const procedure = {
    meta: () => procedure,
    input: () => procedure,
    output: () => procedure,
    mutation: (handler: unknown) => ({ handler }),
    query: (handler: unknown) => ({ handler }),
  }
  return { createTRPCRouter: <T>(router: T) => router, policy: () => procedure }
})
const { default: router } = await import("@/routers/web/projects")
const reorder = router.reorderProjects as unknown as {
  handler: (args: {
    input: { projectIds: number[] }
    ctx: { audit: ReturnType<typeof auditRecorder>["recorder"] }
  }) => Promise<unknown>
}
beforeEach(() => {
  state.rows = [
    { id: 1, title: "One", order: 5 },
    { id: 2, title: "Two", order: 5 },
  ]
})
it("records order values even when tied projects retain their snapshot positions", async () => {
  const audit = auditRecorder()
  await expect(reorder.handler({ input: { projectIds: [1, 99] }, ctx: { audit: audit.recorder } })).resolves.toEqual({
    error: null,
  })
  expect(audit.skipped()).toBe(false)
  expect(audit.note).toMatchObject({
    target: { type: "web.projects", id: "order" },
    before: [
      { id: 1, title: "One", order: 5 },
      { id: 2, title: "Two", order: 5 },
    ],
    after: [
      { id: 1, title: "One", order: 0 },
      { id: 2, title: "Two", order: 5 },
    ],
  })
})
it("skips the audit when all requested projects are missing", async () => {
  const audit = auditRecorder()
  await reorder.handler({ input: { projectIds: [98, 99] }, ctx: { audit: audit.recorder } })
  expect(audit.skipped()).toBe(true)
})
it("retains the audit when a matching row already has the requested order", async () => {
  state.rows[0].order = 0
  const audit = auditRecorder()
  await reorder.handler({ input: { projectIds: [1] }, ctx: { audit: audit.recorder } })
  expect(audit.skipped()).toBe(false)
  expect(audit.note.before).toEqual(audit.note.after)
})
