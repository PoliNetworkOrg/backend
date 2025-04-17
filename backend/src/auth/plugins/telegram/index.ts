import { DB, SCHEMA } from "@/db";
import { type BetterAuthPlugin } from "better-auth";
import { z } from "zod";
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api";
import crypto from "crypto";
import { eq } from "drizzle-orm";

const TTL = 300; // seconds
const CODE_LENGTH = 6;

const linkBody = z.object({
  telegramUsername: z
    .string()
    .transform((s) => (s.startsWith("@") ? s.slice(1) : s)),
});

export const telegramPlugin = () => {
  return {
    id: "telegram",
    schema: {
      user: {
        fields: {
          telegramId: {
            type: "number",
            required: false,
            unique: true,
          },
          telegramUsername: {
            type: "string",
            required: false,
          },
        },
      },
    },
    endpoints: {
      startLink: createAuthEndpoint(
        "/telegram/link/start",
        {
          method: "POST",
          use: [sessionMiddleware],
          body: linkBody,
        },
        async (ctx) => {
          const userId = ctx.context.session?.user.id;
          if (!userId)
            return ctx.error("UNAUTHORIZED", {
              message: "You must be authenticated",
            });

          const { telegramUsername } = ctx.body;
          const [{ code, ttl }] = await DB.insert(SCHEMA.TG.link)
            .values({
              code: crypto
                .randomBytes(CODE_LENGTH)
                .values()
                .map((v) => v % 10)
                .toArray()
                .join(""),
              ttl: TTL,
              userId,
              telegramUsername,
            })
            .returning();

          return ctx.json({ code, ttl });
        },
      ),
      verifyLink: createAuthEndpoint(
        "/telegram/link/verify",
        {
          method: "GET",
          use: [sessionMiddleware],
          query: z.object({
            code: z.string().length(CODE_LENGTH).regex(/^\d+$/),
          }),
        },
        async (ctx) => {
          const userId = ctx.context.session?.user.id;
          if (!userId)
            return ctx.error("UNAUTHORIZED", {
              message: "You must be authenticated",
            });

          const code = ctx.query.code;
          const res = await DB.select()
            .from(SCHEMA.TG.link)
            .where((t) => eq(t.code, code));
          if (!res || res.length !== 1)
            return ctx.error("NOT_FOUND", {
              message: "No link session with this code found",
            });

          const row = res[0];

          if (row.userId !== userId)
            return ctx.error("FORBIDDEN", {
              message: "This link session does not belong to you",
            });

          const expireTime = row.createdAt.getTime() + row.ttl * 1000;
          const expired = Date.now() >= expireTime;

          return ctx.json({ expired, verified: !!row.telegramId });
        },
      ),
    },
  } satisfies BetterAuthPlugin;
};
