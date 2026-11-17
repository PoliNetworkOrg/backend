import { TRPCError } from "@trpc/server"
import z from "zod"
import { associationStore } from "@/associations"
import { linkSchema } from "@/associations/contract"
import { dashboard, publicData } from "@/idp/policies"
import { createTRPCRouter, policy } from "@/trpc"

const associationLinksSchema = z.object({
  email: z.email().nullable(),
  website: z.url().nullable(),
  facebook: z.url().nullable(),
  instagram: z.url().nullable(),
  tiktok: z.url().nullable(),
  x: z.url().nullable(),
  youtube: z.url().nullable(),
  telegram: z.url().nullable(),
  linkedin: z.url().nullable(),
  spotify: z.url().nullable(),
})

const associationSchema = z.object({
  id: z.number(),
  name: z.string(),
  descriptionIt: z.string(),
  descriptionEn: z.string(),
  logo: z.string().nullable(),
  links: associationLinksSchema,
  extraLinks: z.array(linkSchema).optional(),
})

export default createTRPCRouter({
  getAllAssociations: policy(publicData)
    .output(z.array(associationSchema))
    .query(async () => {
      const records = await associationStore.list()
      return records
        .filter((r) => r.registered && r.published && r.status !== "archived" && r.legacyId !== null)
        .map((r) => {
          const p = r.published!
          const first = (key: string) => p.links.find((l) => l.platform === key)?.url ?? null
          return {
            id: r.legacyId!,
            name: p.name,
            descriptionIt: p.descriptionIt,
            descriptionEn: p.descriptionEn,
            logo: p.logo,
            links: {
              email: p.email || null,
              website: first("website"),
              facebook: first("facebook"),
              instagram: first("instagram"),
              tiktok: first("tiktok"),
              x: first("x"),
              youtube: first("youtube"),
              telegram: first("telegram"),
              linkedin: first("linkedin"),
              spotify: first("spotify"),
            },
            extraLinks: p.links,
          }
        })
    }),

  addAssociation: policy(dashboard("web:content:write"))
    .input(z.unknown())
    .mutation(() => retired()),
  editAssociation: policy(dashboard("web:content:write"))
    .input(z.unknown())
    .mutation(() => retired()),
  editAssociationLinks: policy(dashboard("web:content:write"))
    .input(z.unknown())
    .mutation(() => retired()),
  deleteAssociation: policy(dashboard("web:content:write"))
    .input(z.unknown())
    .mutation(() => retired()),
})

function retired(): never {
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: "Use the Associations registry to review and publish changes. The legacy editor is retired.",
  })
}
