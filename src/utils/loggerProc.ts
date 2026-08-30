import { TRPCError } from "@trpc/server"
import { logger } from "@/logger"
import { publicProcedure } from "@/trpc";

function getActionInfo(path: string) {
    const segments = path.split(".")
    return { action: segments.pop(), router: segments.join(".") }
}

export const loggerProcedure = publicProcedure.use(async ({ path, next }) => {
    const result = await next()
    if (!result.ok) {
        const { action, router } = getActionInfo(path)
        logger.error({ error: result.error }, `Error while executing ${action} in ${router} router`)
    }
    return result
})