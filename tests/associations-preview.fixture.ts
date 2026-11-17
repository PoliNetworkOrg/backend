// Local-only browser harness. Never imported by the application server.
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { createAssociationRouter } from "@/associations/router"
import { createTRPCRouter, policy } from "@/trpc"
import { harness } from "./associations-fixture"

const h = harness()
await h.registered()
const router = createTRPCRouter({
  associationPortal: createAssociationRouter(h.service, async (sub) => ({
    name: sub === "owner" ? "Anna Referente" : "Operatore PoliNetwork",
    email: `${sub}@example.org`,
  })),
  me: createTRPCRouter({
    access: policy({ user: { scope: "backend:admin" } }).query(({ ctx }) => ({
      sub: ctx.actor.kind === "user" ? ctx.actor.sub : "",
      telegramId: null,
      permissions: ctx.can("admin:access") ? ["admin:access", "web:content:write"] : [],
      stale: false,
    })),
  }),
  regulations: createTRPCRouter({
    me: createTRPCRouter({
      get: policy({ user: { scope: "backend:admin" } }).query(() => ({ assignedDrafts: 0, deleghe: 0 })),
    }),
  }),
})
Bun.serve({
  port: 15491,
  hostname: "127.0.0.1",
  fetch(req) {
    return fetchRequestHandler({
      endpoint: "/api/trpc",
      req,
      router,
      createContext: () => {
        const raw = req.headers.get("authorization")?.replace("Bearer ", "") ?? ""
        const sub = JSON.parse(Buffer.from(raw.split(".")[1] ?? "", "base64url").toString()).sub
        return {
          auth: {
            kind: "token" as const,
            actor: { kind: "user" as const, sub, client: "preview", telegramId: null },
            scopes: new Set(["backend:admin"]),
          },
          access: {
            has: () => sub === "staff",
            current: () => null,
            subjectBySub: () => undefined,
            subjectByTelegramId: () => undefined,
            status: () => ({ fresh: true, generation: 1, subjects: 2, lastSyncAt: 1 }),
          },
        }
      },
    })
  },
})
console.log("Association test backend ready on 15491")
