import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { dashboard } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import { MAX_RECEIPT_BYTES } from "./fees"
import type { SociService } from "./service"

/**
 * The Libro Soci. Every `members.*` and `fees.*` procedure needs `admin:access` and a `soci:*` permission; the policy
 * carries the `soci:*` one, so the router walk shows it. `me.*` needs `people:self` and finds the socio by the signed-in
 * account's Microsoft 365 object ID, from Auth's access snapshot. Factory keeps policy and shape tests independent of
 * databases and Microsoft 365.
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
  const me = policy(dashboard("people:self")).use(({ ctx, next }) => {
    if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN", message: "Only for signed-in soci" })
    const entraObjectId = ctx.access?.current()?.bySub(ctx.actor.sub)?.entraObjectId ?? null
    if (!entraObjectId)
      throw new TRPCError({ code: "FORBIDDEN", message: "Sign in with your PoliNetwork Microsoft 365 account." })
    return next({ ctx: { sub: ctx.actor.sub, entraObjectId } })
  })
  const receipt = z
    .instanceof(FormData)
    .transform(
      (fd): Record<"file" | "transferDate" | "declaredCents", unknown> => ({
        file: fd.get("file"),
        transferDate: fd.get("transferDate"),
        declaredCents: fd.get("declaredCents"),
      })
    )
    .pipe(
      C.receiptInputSchema.extend({
        file: z.instanceof(File).refine((f) => f.size <= MAX_RECEIPT_BYTES, "The file is larger than 10 MB."),
      })
    )
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
    fees: createTRPCRouter({
      list: read
        .input(C.feesListInputSchema)
        .output(C.feesListSchema)
        .query(({ input }) => soci.listFees(input)),
      file: read
        .input(C.fileInputSchema)
        .output(C.fileSchema)
        .query(({ input }) => soci.feeFile(input)),
      confirm: write.input(C.reviewInputSchema).mutation(({ ctx, input }) => soci.confirmFee(ctx.sub, input)),
      reject: write.input(C.rejectInputSchema).mutation(({ ctx, input }) => soci.rejectFee(ctx.sub, input)),
      markPaid: write.input(C.markPaidInputSchema).mutation(({ ctx, input }) => soci.markPaid(ctx.sub, input)),
    }),
    me: createTRPCRouter({
      get: me.output(C.meSchema).query(({ ctx }) => soci.me(ctx.entraObjectId)),
      uploadReceipt: me.input(receipt).mutation(async ({ ctx, input }) => {
        const { file, ...details } = input
        await soci.uploadReceipt(
          ctx.entraObjectId,
          ctx.sub,
          { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) },
          details
        )
      }),
      completeDetails: me
        .input(C.completeDetailsInputSchema)
        .mutation(({ ctx, input }) => soci.completeDetails(ctx.entraObjectId, ctx.sub, input)),
    }),
  })
}
