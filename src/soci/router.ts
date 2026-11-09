import { TRPCError } from "@trpc/server"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import type { SociService } from "./service"

/**
 * The Libro Soci. Every procedure needs `admin:access` and a `soci:*` permission; the policy carries the `soci:*`
 * one, so the router walk shows it. Factory keeps policy and shape tests independent of databases and Microsoft 365.
 */
export function createSociRouter(soci: SociService) {
  const direttivo = (permission: string) =>
    policy(dashboard(permission)).use(({ ctx, next }) => {
      if (ctx.actor.kind !== "user" || !ctx.can("admin:access"))
        throw new TRPCError({ code: "FORBIDDEN", message: "Missing admin:access" })
      return next({ ctx: { sub: ctx.actor.sub } })
    })
  const read = direttivo("soci:read")
  const write = direttivo("soci:write")
  return createTRPCRouter({
    members: createTRPCRouter({
      list: read.output(C.sociListSchema).query(() => soci.list()),
      get: read
        .input(C.numberInputSchema)
        .output(C.socioRecordSchema)
        .query(({ input }) => soci.get(input)),
      unregistered: read.output(C.unregisteredSchema.array()).query(() => soci.unregistered()),
      admit: write
        .input(C.admitInputSchema)
        .output(C.admitResultSchema)
        .mutation(({ ctx, input }) => soci.admit(ctx.sub, input)),
      register: write
        .input(C.registerInputSchema)
        .output(C.numberInputSchema)
        .mutation(({ ctx, input }) => soci.register(ctx.sub, input)),
      update: write.input(C.updateInputSchema).mutation(({ ctx, input }) => soci.update(ctx.sub, input)),
      setNumber: write
        .input(C.setNumberInputSchema)
        .output(C.setNumberResultSchema)
        .mutation(({ ctx, input }) => soci.setNumber(ctx.sub, input)),
    }),
  })
}
