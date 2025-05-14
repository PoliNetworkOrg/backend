import { DB, SCHEMA } from "@/db";
import { ARRAY_AUDIT_TYPE } from "@/db/schema/tg/audit-log";
import { createTRPCRouter, publicProcedure } from "@/trpc";
import { eq } from "drizzle-orm";
import { z } from "zod";

export default createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({
        adminId: z.number(),
        targetId: z.number(),
        type: z.enum(ARRAY_AUDIT_TYPE),
        groupId: z.number().nullable(), // NULL in "*_ALL" audit types
        until: z.date().nullable(),
        reason: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      await DB.insert(SCHEMA.TG.auditLog)
        .values(input)
        .onConflictDoNothing();
    }),

  getById: publicProcedure
    .input(
      z.object({
        targetId: z.number(),
      }),
    )
    .query(async ({ input }) => {
      return await DB.select()
        .from(SCHEMA.TG.auditLog)
        .where((t) => eq(t.targetId, input.targetId));
    }),
});
