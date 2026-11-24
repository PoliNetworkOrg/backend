import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { uploadBlob } from "@/azure/blob"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import type { createHomeService } from "./home"
import type { createPromotionService } from "./promotions"
import type { createAssociationService } from "./service"

const uploads = new Map<string, number[]>()
function limitUploads(sub: string) {
  const now = Date.now()
  const recent = (uploads.get(sub) ?? []).filter((t) => t > now - 3600_000)
  if (recent.length >= 20) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many uploads. Try later." })
  uploads.set(sub, [...recent, now])
}
const imageForm = (maxBytes: number) =>
  z
    .instanceof(FormData)
    .transform((fd) => ({ id: fd.get("id"), file: fd.get("file") }))
    .pipe(z.object({ id: z.uuid(), file: z.file().min(1).max(maxBytes).mime(["image/png", "image/jpeg"]) }))
/** Checks the bytes, not just the declared type, and stores the image in the same Blob container as logos. */
async function storeImage(file: File, message: string) {
  const bytes = Buffer.from(await file.arrayBuffer())
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if ((!png && !jpeg) || (png ? file.type !== "image/png" : file.type !== "image/jpeg"))
    throw new TRPCError({ code: "BAD_REQUEST", message })
  const uploaded = await uploadBlob(bytes, png ? "png" : "jpg", png ? "image/png" : "image/jpeg")
  return { url: uploaded.url }
}

function need<T>(part: T | undefined): T {
  if (!part) throw new TRPCError({ code: "NOT_IMPLEMENTED", message: "Not available" })
  return part
}

export function createAssociationRouter(
  service: ReturnType<typeof createAssociationService>,
  identity: (sub: string) => Promise<{ name: string; email?: string }> = async (sub) => ({ name: sub }),
  promotions?: ReturnType<typeof createPromotionService>,
  home?: ReturnType<typeof createHomeService>
) {
  // Being authenticated admits an applicant; membership is checked afresh by the service, never trusted from input.
  const user = policy({ user: { scope: SCOPE.admin } }).use(async ({ ctx, next }) => {
    if (ctx.actor.kind !== "user") throw new TRPCError({ code: "FORBIDDEN" })
    const subject = await identity(ctx.actor.sub)
    return next({
      ctx: {
        viewer: {
          sub: ctx.actor.sub,
          name: subject.name,
          email: subject.email,
          operator: ctx.can("admin:access") && ctx.can("web:content:write"),
        },
      },
    })
  })
  return createTRPCRouter({
    uploadLogo: user
      .input(imageForm(1024 * 1024))
      .output(z.object({ url: C.httpUrl }))
      .mutation(async ({ ctx, input }) => {
        const record = await service.get(ctx.viewer, input.id)
        if (
          !record.canEdit &&
          !record.requests.some(
            (q) => q.kind === "registration" && q.by === ctx.viewer.sub && ["draft", "changes"].includes(q.status)
          )
        )
          throw new TRPCError({ code: "FORBIDDEN" })
        limitUploads(ctx.viewer.sub)
        return storeImage(input.file, "Choose a valid PNG or JPEG logo")
      }),
    /** A poster for a promotion request or an event: `id` is the association; representatives only. */
    uploadPoster: user
      .input(imageForm(5 * 1024 * 1024))
      .output(z.object({ url: C.httpUrl }))
      .mutation(async ({ ctx, input }) => {
        const record = await service.get(ctx.viewer, input.id)
        if (!record.role || record.status !== "active") throw new TRPCError({ code: "FORBIDDEN" })
        limitUploads(ctx.viewer.sub)
        return storeImage(input.file, "Choose a valid PNG or JPEG poster")
      }),
    list: user.output(C.dashboardSchema).query(({ ctx }) => service.list(ctx.viewer)),
    home: user.output(C.homeSchema).query(({ ctx }) => need(home).home(ctx.viewer)),
    directory: user.output(C.directorySchema).query(({ ctx }) => service.directory(ctx.viewer)),
    catalogue: user.output(C.catalogueSchema).query(({ ctx }) => service.catalogue(ctx.viewer)),
    saveCatalogue: user
      .input(C.catalogueEntrySchema)
      .output(z.object({ ok: z.literal(true) }))
      .mutation(async ({ ctx, input }) => {
        await service.saveCatalogue(ctx.viewer, input)
        return { ok: true as const }
      }),
    get: user
      .input(C.refSchema)
      .output(C.detailSchema)
      .query(({ ctx, input }) => service.get(ctx.viewer, input.id)),
    create: user
      .input(C.createSchema)
      .output(C.refSchema)
      .mutation(({ ctx, input }) => service.create(ctx.viewer, input)),
    command: user
      .input(C.commandSchema)
      .output(C.refSchema)
      .mutation(({ ctx, input }) => service.command(ctx.viewer, input)),
    invitation: user
      .input(C.inviteSchema)
      .output(C.invitationSchema)
      .query(({ input }) => service.invitation(input.token)),
    accept: user
      .input(C.inviteSchema)
      .output(C.refSchema)
      .mutation(({ ctx, input }) => service.accept(ctx.viewer, input.token)),
    promotions: createTRPCRouter({
      list: user
        .input(C.refSchema)
        .output(C.promotionListSchema)
        .query(({ ctx, input }) => need(promotions).list(ctx.viewer, input.id)),
      get: user
        .input(C.refSchema)
        .output(C.promotionSchema)
        .query(({ ctx, input }) => need(promotions).get(ctx.viewer, input.id)),
      queue: user
        .input(C.promotionQueueSchema)
        .output(C.promotionListSchema)
        .query(({ ctx, input }) => need(promotions).queue(ctx.viewer, input)),
      create: user
        .input(C.promotionCreateSchema)
        .output(C.refSchema)
        .mutation(({ ctx, input }) => need(promotions).create(ctx.viewer, input)),
      command: user
        .input(C.promotionCommandSchema)
        .output(C.refSchema)
        .mutation(({ ctx, input }) => need(promotions).command(ctx.viewer, input)),
    }),
    lookup: user
      .input(C.refSchema)
      .output(z.object({ id: z.uuid(), name: z.string(), revision: z.number() }))
      .query(async ({ ctx, input }) => {
        const item = (await service.directory(ctx.viewer)).find((r) => r.id === input.id)
        if (!item) throw new TRPCError({ code: "NOT_FOUND" })
        return { id: item.id, name: item.name, revision: item.revision }
      }),
  })
}
