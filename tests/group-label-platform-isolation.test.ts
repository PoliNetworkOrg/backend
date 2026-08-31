import { readFile } from "node:fs/promises"
import { beforeEach, expect, test, vi } from "vitest"

const state = vi.hoisted(() => {
  const tables = {
    groupLabels: { id: "group-labels.id", label: "group-labels.label" },
    tgRelations: { groupId: "tg-relations.group-id", labelId: "tg-relations.label-id" },
    waRelations: { groupId: "wa-relations.group-id", labelId: "wa-relations.label-id" },
    tgGroups: { telegramId: "tg-groups.telegram-id" },
    waGroups: { id: "wa-groups.id" },
  }

  const selectResults: unknown[][] = []
  const selectedTables: unknown[] = []
  const insertedTables: unknown[] = []
  const deletedTables: unknown[] = []

  const DB = {
    select: () => ({
      from: (table: unknown) => {
        selectedTables.push(table)
        return {
          where: () => ({
            limit: async () => selectResults.shift() ?? [],
          }),
        }
      },
    }),
    insert: (table: unknown) => {
      insertedTables.push(table)
      return {
        values: (values: unknown) => ({
          returning: async () => [values],
        }),
      }
    },
    delete: (table: unknown) => {
      deletedTables.push(table)
      return {
        where: () => ({
          returning: async () => [],
        }),
      }
    },
  }

  return { DB, deletedTables, insertedTables, selectResults, selectedTables, tables }
})

vi.mock("drizzle-orm", () => ({
  and: () => undefined,
  eq: () => undefined,
  sql: () => undefined,
}))

vi.mock("@/db", () => ({
  DB: state.DB,
  SCHEMA: {
    COMMON: { groupLabels: state.tables.groupLabels },
    TG: { groups: state.tables.tgGroups, tgGroupLabelRelations: state.tables.tgRelations },
    WA: { waGroups: state.tables.waGroups, waGroupLabelRelations: state.tables.waRelations },
  },
}))

vi.mock("@/trpc", () => {
  const publicProcedure = {
    input: (schema: { parse: (input: unknown) => unknown }) => ({
      mutation: (handler: (args: { input: unknown }) => unknown) => ({
        execute: (input: unknown) => handler({ input: schema.parse(input) }),
      }),
    }),
    query: (handler: () => unknown) => ({ handler }),
  }
  return { createTRPCRouter: <T>(router: T) => router, publicProcedure }
})

const { default: labelsRouter } = await import("@/routers/groups/labels")
const mockedLabelsRouter = labelsRouter as unknown as {
  tagGroup: { execute: (input: unknown) => Promise<unknown> }
  untagGroup: { execute: (input: unknown) => Promise<unknown> }
}

beforeEach(() => {
  state.selectResults.length = 0
  state.selectedTables.length = 0
  state.insertedTables.length = 0
  state.deletedTables.length = 0
})

test("colliding group IDs are assigned labels only on the requested platform", async () => {
  state.selectResults.push([{ id: 7 }], [{ id: 3 }])
  await mockedLabelsRouter.tagGroup.execute({ groupId: 7, type: "tg", label: "students" })

  expect(state.selectedTables[0]).toBe(state.tables.tgGroups)
  expect(state.insertedTables).toEqual([state.tables.tgRelations])

  state.selectResults.push([{ id: 7 }], [{ id: 3 }])
  await mockedLabelsRouter.tagGroup.execute({ groupId: 7, type: "wa", label: "students" })

  expect(state.selectedTables[2]).toBe(state.tables.waGroups)
  expect(state.insertedTables).toEqual([state.tables.tgRelations, state.tables.waRelations])
})

test("colliding group IDs are untagged only on the requested platform", async () => {
  state.selectResults.push([{ id: 7 }], [{ id: 3 }])
  await mockedLabelsRouter.untagGroup.execute({ groupId: 7, type: "tg", label: "students" })

  expect(state.deletedTables).toEqual([state.tables.tgRelations])

  state.selectResults.push([{ id: 7 }], [{ id: 3 }])
  await mockedLabelsRouter.untagGroup.execute({ groupId: 7, type: "wa", label: "students" })

  expect(state.deletedTables).toEqual([state.tables.tgRelations, state.tables.waRelations])
})

test("group label searches join group ID and platform", async () => {
  const source = await readFile(new URL("../src/routers/groups/search.ts", import.meta.url), "utf8")

  expect(source).toMatch(/const samePlatform = sql`\$\{LABEL_RELATIONS\}\.type = \$\{GROUPS\}\.type`/)
  expect((source.match(/samePlatform/g) ?? []).length).toBe(5)
})
