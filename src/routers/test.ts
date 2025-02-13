import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";
import { DB, SCHEMA } from "src/db";

export const testRouter = createTRPCRouter({
  dbQuery: publicProcedure
    .input(z.object({ dbName: z.enum(["web", "tg"]) }))
    .query(async ({ input }) => {
      if (input.dbName === "tg") {
        const q = await DB.TG.select().from(SCHEMA.TG.testTable).limit(50);
        return q.map((e) => e.text);
      }

      const q = await DB.WEB.select().from(SCHEMA.WEB.testTable).limit(50);
      return q.map((e) => e.text);
    }),

  dbInsert: publicProcedure
    .input(z.object({ text: z.string(), dbName: z.enum(["web", "tg"]) }))
    .mutation(async ({ input }) => {
      if (input.dbName === "tg") {
        await DB.TG.insert(SCHEMA.TG.testTable).values({ text: input.text });
        return true;
      }

      await DB.WEB.insert(SCHEMA.WEB.testTable).values({ text: input.text });
      return true;
    }),
});
