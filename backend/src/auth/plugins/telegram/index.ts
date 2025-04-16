import { DB, SCHEMA } from "@/db";
import { z, type BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
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
        },
        async (ctx) => {
          const userId = ctx.context.session?.user.id;
          if (!userId)
            return ctx.error("UNAUTHORIZED", {
              message: "You must be authenticated",
            });

          const { data, success } = linkBody.safeParse(ctx.body);
          if (!success)
            return ctx.error("BAD_REQUEST", {
              message:
                "'telegramUsername' must be provided and must be a string",
            });

          const { telegramUsername } = data;
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
        "/telegram/link/verify/:code",
        {
          method: "GET",
        },
        async (ctx) => {
          const userId = ctx.context.session?.user.id;
          if (!userId)
            return ctx.error("UNAUTHORIZED", {
              message: "You must be authenticated",
            });

          const code = ctx.params?.code;
          if (!code || code.length !== CODE_LENGTH || /^\d+$/.test(code))
            return ctx.error("BAD_REQUEST", {
              message: "The code must be a 6-digit string",
            });

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
