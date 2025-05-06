import { DB, SCHEMA } from "@/db";
import {
  ARRAY_USER_ROLE,
  TUserRole,
  USER_ROLE,
} from "@/db/schema/tg/permissions";
import { createTRPCRouter, publicProcedure } from "@/trpc";
import { and, eq } from "drizzle-orm";
import { z } from "zod";

const s = SCHEMA.TG;

export default createTRPCRouter({
  getRole: publicProcedure
    .input(z.object({ userId: z.number() }))
    .query(async ({ input }) => {
      const [res] = await DB.select({
        role: s.permissions.role,
      })
        .from(s.permissions)
        .where(eq(s.permissions.userId, input.userId))
        .limit(1);

      return {
        userId: input.userId,
        role: res ? res.role : "user",
      };
    }),

  setRole: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        role: z.enum(ARRAY_USER_ROLE),
        adderId: z.number(),
      }),
    )
    .query(async ({ input }) => {
      await DB.insert(s.permissions)
        .values({
          userId: input.userId,
          role: input.role,
          addedBy: input.adderId,
        })
        .onConflictDoUpdate({
          target: s.permissions.userId,
          set: { role: input.role, modifiedBy: input.adderId },
        });
    }),

  checkGroup: publicProcedure
    .input(z.object({ userId: z.number(), groupId: z.number() }))
    .query(async ({ input }) => {
      const res = await DB.$count(
        s.groupAdmins,
        and(
          eq(s.groupAdmins.userId, input.userId),
          eq(s.groupAdmins.groupId, input.groupId),
        ),
      );

      return res != 0;
    }),

  addGroup: publicProcedure
    .input(
      z.object({
        userId: z.number(),
        adderId: z.number(),
        groupId: z.number(),
      }),
    )
    .query(async ({ input }) => {
      await DB.insert(s.groupAdmins)
        .values({
          userId: input.userId,
          groupId: input.groupId,
          addedBy: input.adderId,
        })
        .onConflictDoNothing();
    }),

  canAddBot: publicProcedure
    .input(
      z.object({
        userId: z.number(),
      }),
    )
    .output(
      z.union([
        z.object({ allowed: z.boolean(), error: z.null() }),
        z.object({
          allowed: z.literal(false),
          error: z.enum(["NOT_FOUND"]),
        }),
      ]),
    )
    .query(async ({ input }) => {
      const res = await DB.select({ role: s.permissions.role })
        .from(s.permissions)
        .where(eq(s.permissions.userId, input.userId))
        .limit(1);

      if (!res[0]) return { error: "NOT_FOUND", allowed: false };
      const { role } = res[0];
      const allowed = (
        [
          USER_ROLE.HR,
          USER_ROLE.OWNER,
          USER_ROLE.CREATOR,
          USER_ROLE.DIRETTIVO,
        ] as TUserRole[]
      ).includes(role);

      return { error: null, allowed };
    }),
});
