import { TRPCError } from "@trpc/server"
import { z } from "zod"
import { uploadBlob } from "@/azure/blob"
import { SCOPE } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"
import * as C from "./contract"
import type { createAssociationService } from "./service"

const uploads = new Map<string, number[]>()
function limitUploads(sub: string) {
  const now = Date.now()
  const recent = (uploads.get(sub) ?? []).filter((t) => t > now - 3600_000)
  if (recent.length >= 20)
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many logo uploads. Try later." })
  uploads.set(sub, [...recent, now])
}

export function createAssociationRouter(
  service: ReturnType<typeof createAssociationService>,
  identity: (sub: string) => Promise<{ name: string; email?: string }> = async (sub) => ({ name: sub })
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
      .input(
        z
          .instanceof(FormData)
          .transform((fd) => ({ id: fd.get("id"), file: fd.get("file") }))
          .pipe(
            z.object({
              id: z.uuid(),
              file: z
                .file()
                .min(1)
                .max(1024 * 1024)
                .mime(["image/png", "image/jpeg"]),
            })
          )
      )
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
        const bytes = Buffer.from(await input.file.arrayBuffer())
        const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        if ((!png && !jpeg) || (png ? input.file.type !== "image/png" : input.file.type !== "image/jpeg"))
          throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a valid PNG or JPEG logo" })
        const uploaded = await uploadBlob(bytes, png ? "png" : "jpg", png ? "image/png" : "image/jpeg")
        return { url: uploaded.url }
      }),
    list: user.output(C.dashboardSchema).query(({ ctx }) => service.list(ctx.viewer)),
    directory: user.output(C.directorySchema).query(() => service.directory()),
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
    lookup: user
      .input(C.refSchema)
      .output(z.object({ id: z.uuid(), name: z.string(), revision: z.number() }))
      .query(async ({ input }) => {
        const item = (await service.directory()).find((r) => r.id === input.id)
        if (!item) throw new TRPCError({ code: "NOT_FOUND" })
        return item
      }),
  })
}
