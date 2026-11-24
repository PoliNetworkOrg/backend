import { TRPCError } from "@trpc/server"
import z from "zod"
import { associationEventStore, associationStore } from "@/associations"
import { contactFunction, linkSchema } from "@/associations/contract"
import { publicAssociations, publicEvents } from "@/associations/public"
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

const named = z.object({ slug: z.string(), nameIt: z.string(), nameEn: z.string() })
const upcomingEventSchema = z.object({
  id: z.uuid(),
  /** The association's public id, as in `getAllAssociations`. */
  associationId: z.number(),
  associationName: z.string(),
  title: z.string(),
  descriptionIt: z.string(),
  descriptionEn: z.string(),
  startsAt: z.string(),
  endsAt: z.string().nullable(),
  online: z.boolean(),
  venue: z.string(),
  campus: named.nullable(),
  link: z.string().nullable(),
  poster: z.string().nullable(),
})

export default createTRPCRouter({
  /** Approved association events that are not over yet, soonest first. */
  getUpcomingEvents: policy(publicData)
    .output(z.array(upcomingEventSchema))
    .query(() => publicEvents(associationStore, associationEventStore)),

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
