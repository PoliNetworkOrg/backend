import { z } from "zod/v4";
import { createTRPCRouter, publicProcedure } from "@/trpc";
import { DB, SCHEMA } from "src/db";

export const testRouter = createTRPCRouter({
  dbQuery: publicProcedure
    .input(z.object({ dbName: z.enum(["web", "tg"]) }))
    .query(async ({ input }) => {
      if (input.dbName === "tg") {
        const q = await DB.select().from(SCHEMA.TG.test).limit(50);
        return q.map((e) => e.text);
      }

      const q = await DB.select().from(SCHEMA.WEB.test).limit(50);
      return q.map((e) => e.text);
    }),

  dbInsert: publicProcedure
    .input(z.object({ text: z.string(), dbName: z.enum(["web", "tg"]) }))
    .mutation(async ({ input }) => {
      if (input.dbName === "tg") {
        await DB.insert(SCHEMA.TG.test).values({ text: input.text });
        return true;
      }

      await DB.insert(SCHEMA.WEB.test).values({ text: input.text });
      return true;
    }),
});
