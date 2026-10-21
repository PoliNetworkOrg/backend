import { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"
import { logger } from "@/logger"
import { EsignError, HTTP_STATUS } from "./errors"
import type { EsignService } from "./service"

const base64 = z
  .string()
  .max(64 * 1024)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/)

/** `protocol` 2: the agent signs a job's places one after another and several jobs with one PIN. */
const prepareBody = z.object({
  certificate: base64,
  chain: z.array(base64).max(4).optional(),
  protocol: z.number().int().optional(),
})
const completeBody = z.object({ signature: base64 })
const failBody = z.object({ code: z.string().max(60), message: z.string().max(500).nullable().optional() })

/**
 * The sign agent's endpoints, mounted at `/esign/agent` and reached through the dashboard's proxy. The ticket in
 * the path is the only credential: a single-use, ten-minute capability for one signature. The proxy passes on the
 * agent's `User-Agent: PoliNetwork-eSign/<version>` (`PoliNetwork-Sign-Agent/<version>` before 0.2.0), which loading
 * a job and preparing a signature check.
 */
export function agentRoutes(service: EsignService) {
  const app = new Hono()
  app.use("*", bodyLimit({ maxSize: 256 * 1024 }))
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    await next()
  })
  app.onError((error, c) => {
    if (error instanceof EsignError)
      return c.json(
        { error: { code: error.code, message: error.message } },
        HTTP_STATUS[error.code] as ContentfulStatusCode
      )
    logger.error({ error }, "[ESIGN] agent endpoint failed")
    return c.json({ error: { code: "internal", message: "Something went wrong. Try again." } }, 500)
  })

  const parse = async <T>(schema: z.ZodType<T>, body: Promise<unknown>): Promise<T> => {
    const result = schema.safeParse(await body.catch(() => null))
    if (!result.success) throw new EsignError("bad_request", "Malformed request")
    return result.data
  }

  app.get("/jobs/:ticket", async (c) =>
    c.json({ job: await service.agentJob(c.req.param("ticket"), c.req.header("user-agent") ?? null) })
  )
  app.post("/jobs/:ticket/prepare", async (c) => {
    const body = await parse(prepareBody, c.req.json())
    return c.json(
      await service.agentPrepare(
        c.req.param("ticket"),
        body.certificate,
        body.chain,
        body.protocol ?? 1,
        c.req.header("user-agent") ?? null
      )
    )
  })
  app.post("/jobs/:ticket/complete", async (c) => {
    const body = await parse(completeBody, c.req.json())
    return c.json(await service.agentComplete(c.req.param("ticket"), body.signature))
  })
  app.post("/jobs/:ticket/fail", async (c) => {
    const body = await parse(failBody, c.req.json())
    return c.json(await service.agentFail(c.req.param("ticket"), body.code, body.message ?? null))
  })
  return app
}
