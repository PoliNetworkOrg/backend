import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "@/db/schema"

const TEST_ENV = {
  DB_HOST: "localhost",
  DB_PORT: 5432,
  DB_USER: "postgres",
  DB_PASS: "postgres",
  DB_NAME: "polinetwork_backend_test",
}

let testPool: Pool
let testDB: ReturnType<typeof drizzle<typeof schema>>

vi.mock("@/db", async () => {
  const { Pool } = await import("pg")
  const { drizzle } = await import("drizzle-orm/node-postgres")
  const schema = await import("@/db/schema")
  
  testPool = new Pool({
    host: TEST_ENV.DB_HOST,
    port: TEST_ENV.DB_PORT,
    user: TEST_ENV.DB_USER,
    password: TEST_ENV.DB_PASS,
    database: TEST_ENV.DB_NAME,
  })
  
  testDB = drizzle(testPool, { schema: schema.default || schema })
  
  return {
    DB: testDB,
    SCHEMA: schema.default || schema,
    VIEWS: { GROUPS: {} },
  }
})

beforeAll(() => {
  // env vars set in setup.ts
})

beforeEach(async () => {
  vi.clearAllMocks()
  if (testDB) {
    await testDB.delete(schema.moderationLog)
    await testDB.delete(schema.banAllLog)
    await testDB.delete(schema.deletedLog)
    await testDB.delete(schema.exceptionLog)
    await testDB.delete(schema.groupManagementLog)
    await testDB.delete(schema.grantLog)
    await testDB.delete(schema.messages)
  }
})

afterAll(async () => {
  if (testPool) await testPool.end()
})

// Import router after mock
const { default: auditLogRouter } = await import("@/routers/tg/audit-log")

describe("Audit Log Router", () => {
  async function createCaller() {
    return auditLogRouter.createCaller({})
  }

  describe("create - Moderation", () => {
    it("creates a moderation log entry with full input", async () => {
      const caller = await createCaller()
      const result = await caller.create({
        category: "moderation",
        adminId: 123,
        admin: { id: 123, is_bot: false, first_name: "Admin", username: "admin" },
        targetId: 456,
        target: { id: 456, is_bot: false, first_name: "Target", username: "target" },
        chatId: 789,
        chat: { id: 789, type: "group", title: "Test Group" },
        type: "ban",
        reason: "Spam",
        duration: { raw: "1h", date: new Date(Date.now() + 3600000).toISOString(), timestamp_s: Math.floor((Date.now() + 3600000)/1000), secondsFromNow: 3600, dateStr: new Date(Date.now() + 3600000).toISOString() },
        preDeleteRes: null,
        source: "manual",
      })
      expect(result).toBeUndefined()
      const records = await testDB.select().from(schema.moderationLog)
      expect(records).toHaveLength(1)
      expect(records[0].adminId).toBe(123)
      expect(records[0].type).toBe("ban")
      expect(records[0].status).toBe("pending")
    })

    it("creates a moderation log entry with legacy input", async () => {
      const caller = await createCaller()
      await caller.create({ adminId: 123, targetId: 456, type: "mute", groupId: 789, until: new Date(Date.now() + 3600000), reason: "Auto mute" })
      const records = await testDB.select().from(schema.moderationLog)
      expect(records).toHaveLength(1)
      expect(records[0].type).toBe("mute")
      expect(records[0].source).toBe("chat_member_update")
      expect(records[0].duration).not.toBeNull()
    })
  })

  describe("create - Ban All", () => {
    it("creates a ban_all log entry", async () => {
      const caller = await createCaller()
      await caller.create({ category: "ban_all", adminId: 123, admin: { id: 123, is_bot: false, first_name: "Admin" }, targetId: 456, target: { id: 456, is_bot: false, first_name: "Target" }, type: "ban_all", reason: "Global ban", source: "manual" })
      const records = await testDB.select().from(schema.banAllLog)
      expect(records).toHaveLength(1)
      expect(records[0].type).toBe("ban")
    })

    it("creates unban_all with legacy input", async () => {
      const caller = await createCaller()
      await caller.create({ adminId: 123, targetId: 456, type: "unban_all", groupId: null, until: null, reason: "Global unban" })
      const records = await testDB.select().from(schema.banAllLog)
      expect(records).toHaveLength(1)
      expect(records[0].type).toBe("unban")
    })
  })

  describe("create - Deleted", () => {
    it("creates a deleted log entry", async () => {
      const caller = await createCaller()
      await caller.create({ category: "deleted", messageId: 111, chatId: 789, authorId: 456, author: { id: 456, is_bot: false, first_name: "Author" }, deletedById: 123, deletedBy: { id: 123, is_bot: false, first_name: "Admin" }, deletedAt: new Date(), reason: "Test", preDeleteRes: { count: 1, logMessageIds: [111], link: "https://t.me/c/..." }, source: "moderation" })
      const records = await testDB.select().from(schema.deletedLog)
      expect(records).toHaveLength(1)
      expect(records[0].messageId).toBe(111)
    })
  })

  describe("create - Exception", () => {
    it("creates an exception log entry", async () => {
      const caller = await createCaller()
      await caller.create({ category: "exception", type: "GENERIC", error: { message: "Test" }, context: { handler: "test" }, source: "bot" })
      const records = await testDB.select().from(schema.exceptionLog)
      expect(records).toHaveLength(1)
      expect(records[0].type).toBe("GENERIC")
    })

    it("creates a BOT_ERROR exception entry", async () => {
      const caller = await createCaller()
      await caller.create({ category: "exception", type: "BOT_ERROR", error: { ok: false, error_code: 400, description: "Bad Request", method: "sendMessage" }, context: { chatId: 123 }, source: "api" })
      const records = await testDB.select().from(schema.exceptionLog)
      expect(records).toHaveLength(1)
      expect(records[0].type).toBe("BOT_ERROR")
    })
  })

  describe("create - Group Management", () => {
    it("creates a group management log entry", async () => {
      const caller = await createCaller()
      await caller.create({ category: "group_management", type: "create", chat: { id: 789, type: "group", title: "New Group" }, addedBy: { id: 123, is_bot: false, first_name: "Admin" }, inviteLink: "https://t.me/newgroup", source: "bot" })
      const records = await testDB.select().from(schema.groupManagementLog)
      expect(records).toHaveLength(1)
      expect(records[0].type).toBe("create")
    })
  })

  describe("create - Grant", () => {
    it("creates a grant log entry", async () => {
      const caller = await createCaller()
      await caller.create({ category: "grant", action: "create", target: { id: 456, is_bot: false, first_name: "Target" }, by: { id: 123, is_bot: false, first_name: "Admin" }, since: new Date(), until: new Date(Date.now() + 86400000), reason: "VIP access", source: "bot" })
      const records = await testDB.select().from(schema.grantLog)
      expect(records).toHaveLength(1)
      expect(records[0].action).toBe("create")
    })
  })

  describe("update", () => {
    it("updates moderation log status and progress", async () => {
      const caller = await createCaller()
      await caller.create({ category: "moderation", adminId: 123, admin: { id: 123, is_bot: false, first_name: "Admin" }, targetId: 456, target: { id: 456, is_bot: false, first_name: "Target" }, chatId: 789, chat: { id: 789, type: "group" }, type: "ban", reason: "Test", source: "manual" })
      const created = await testDB.select().from(schema.moderationLog)
      const id = created[0].id
      const result = await caller.update({ id, status: "completed", deletedMessageCount: 5, totalGroupCount: 1, successGroupCount: 1, failedGroupCount: 0 })
      expect(result.updated).toBe(true)
      const updated = await testDB.select().from(schema.moderationLog).where(eq(schema.moderationLog.id, id))
      expect(updated[0].status).toBe("completed")
    })
  })

  describe("markMessagesDeleted", () => {
    it("marks messages as deleted", async () => {
      const caller = await createCaller()
      await testDB.insert(schema.messages).values([{ chatId: 789, messageId: 100, authorId: 456, timestamp: new Date(), message: "Test 1" }, { chatId: 789, messageId: 101, authorId: 456, timestamp: new Date(), message: "Test 2" }])
      const result = await caller.markMessagesDeleted({ chatId: 789, messageIds: [100, 101] })
      expect(result.count).toBe(2)
      const messages = await testDB.select().from(schema.messages).where(eq(schema.messages.chatId, 789))
      expect(messages.every(m => m.deletedAt !== null)).toBe(true)
    })
  })
})
