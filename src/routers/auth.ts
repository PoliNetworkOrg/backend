import { eq } from "drizzle-orm"
import z from "zod"
import { uploadBlob } from "@/azure/blob"
import { DB, SCHEMA } from "@/db"
import { logger } from "@/logger"
import { createTRPCRouter, publicProcedure } from "@/trpc"

export const authRouter = createTRPCRouter({
  updateProfilePic: publicProcedure
    .input(
      z
        .instanceof(FormData)
        .transform((fd): Record<string, string | File> => Object.fromEntries(fd.entries()))
        .pipe(
          z.object({
            userId: z.string(),
            image: z
              .file()
              .mime(["image/png", "image/jpeg"])
              .min(1)
              .max(1024 * 1024), // 1MB
          })
        )
    )
    .mutation(async ({ input }) => {
      try {
        const buffer = Buffer.from(await input.image.arrayBuffer())
        const file = await uploadBlob(buffer, input.image.type.includes("png") ? "png" : "jpeg", input.image.type)
        await DB.update(SCHEMA.AUTH.user).set({ image: file.url }).where(eq(SCHEMA.AUTH.user.id, input.userId))
        return { success: true }
      } catch (err) {
        logger.error({ err }, "authRouter updateProfilePic error")
        return { success: false }
      }
    }),
})
