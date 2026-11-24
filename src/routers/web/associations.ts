import { TRPCError } from "@trpc/server"
import z from "zod"
import { associationStore } from "@/associations"
import { contactFunction, linkSchema } from "@/associations/contract"
import { publicAssociations } from "@/associations/public"
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
  // Added with programmes, campuses and contacts; optional so older clients and SDKs keep working.
  programmes: z.array(z.object({ slug: z.string(), nameIt: z.string(), nameEn: z.string() })).optional(),
  campuses: z.array(z.object({ slug: z.string(), nameIt: z.string(), nameEn: z.string() })).optional(),
  crossProgramme: z.boolean().optional(),
  contacts: z
    .array(
      z.object({
        function: contactFunction,
        label: z.string(),
        email: z.string(),
        name: z.string(),
        phone: z.string(),
      })
    )
    .optional(),
})

export default createTRPCRouter({
  getAllAssociations: policy(publicData)
    .output(z.array(associationSchema))
    .query(() => publicAssociations(associationStore)),

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
