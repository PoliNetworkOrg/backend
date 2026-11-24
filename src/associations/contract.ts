import { z } from "zod"

const text = z.string().trim().max(20000)
const reason = z.string().trim().min(1).max(4000)
export const httpUrl = z
  .url()
  .max(2048)
  .refine((s) => /^https?:\/\//i.test(s), "Use an HTTP or HTTPS link")
export const linkSchema = z.object({
  platform: z.enum([
    "website",
    "facebook",
    "instagram",
    "tiktok",
    "x",
    "youtube",
    "telegram",
    "linkedin",
    "spotify",
    "twitch",
    "other",
  ]),
  label: z.string().trim().min(1).max(100),
  url: httpUrl,
})
/** A catalogue key: `didattica.<school>.<level>.<course>` for a programme (as in the group labels), a word for a campus. */
export const catalogueSlug = z
  .string()
  .trim()
  .min(1)
  .max(160)
  .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)*$/, "Use lowercase letters, digits, dashes and dots")
export const catalogueKind = z.enum(["programme", "campus"])
export const catalogueEntrySchema = z.object({
  kind: catalogueKind,
  slug: catalogueSlug,
  nameIt: z.string().trim().min(1).max(200),
  nameEn: z.string().trim().min(1).max(200),
  active: z.boolean(),
})
export const contactFunction = z.enum(["presidency", "events", "collaborations", "communications", "other"])
/** `public`: on the website after review; `associations`: other active associations' representatives; `polinetwork`: the association itself and operators. */
export const contactVisibility = z.enum(["public", "associations", "polinetwork"])
export const contactSchema = z.object({
  id: z.uuid(),
  function: contactFunction,
  label: z.string().trim().min(1).max(100),
  email: z.email().max(320),
  // Personal data: optional, and shown with a privacy notice when entered.
  name: z.string().trim().max(120).default(""),
  phone: z
    .string()
    .trim()
    .max(40)
    .regex(/^[+0-9 ()./-]*$/, "Use digits, spaces and + ( ) . / -")
    .default(""),
  visibility: contactVisibility,
  // The representative a personal contact refers to; flagged for update once they lose access.
  holderSub: z.string().max(200).nullable().default(null),
})
export const publicContactSchema = contactSchema.extend({ visibility: z.literal("public") })
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  acronym: z.string().trim().max(50),
  descriptionIt: text,
  descriptionEn: text,
  logo: httpUrl.nullable(),
  email: z.union([z.literal(""), z.email().max(320)]),
  links: z.array(linkSchema).max(30),
  // Added after the first release: absent on older records and responses, hence the defaults.
  programmes: z.array(catalogueSlug).max(40).default([]),
  campuses: z.array(catalogueSlug).max(20).default([]),
  crossProgramme: z.boolean().default(false),
  contacts: z.array(publicContactSchema).max(20).default([]),
})
export const requestStatus = z.enum(["draft", "submitted", "changes", "approved", "rejected", "withdrawn"])
export const roleSchema = z.enum(["responsible", "collaborator"])
export const memberSchema = z.object({ sub: z.string(), name: z.string(), role: roleSchema, active: z.boolean() })
export const requestSchema = z.object({
  id: z.uuid(),
  redirectId: z.uuid().nullable().default(null),
  kind: z.enum(["registration", "access", "membership", "content"]),
  status: requestStatus,
  by: z.string(),
  byName: z.string(),
  explanation: z.string(),
  response: z.string(),
  profile: profileSchema.nullable(),
  targetSub: z.string().nullable(),
  targetName: z.string().nullable(),
  targetEmail: z.string().default(""),
  role: roleSchema,
  email: z.string(),
  remove: z.boolean(),
  accepted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  decidedBy: z.string().nullable(),
})
export const eventSchema = z.object({
  requestId: z.uuid().optional(),
  id: z.uuid(),
  at: z.string(),
  actor: z.string(),
  action: z.string(),
  detail: z.string(),
})
export const summarySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  status: z.enum(["pending", "active", "suspended", "archived"]),
  registered: z.boolean(),
  published: z.boolean(),
  role: roleSchema.nullable(),
  pending: z.number(),
  unrepresented: z.boolean(),
})
export const detailSchema = summarySchema.extend({
  revision: z.number().int(),
  profile: profileSchema,
  publishedProfile: profileSchema.nullable(),
  /** Non-public contacts; empty for anyone who is not a representative or an operator. */
  contacts: z.array(contactSchema).default([]),
  /** Contacts (public or not) whose linked representative no longer has access. */
  staleContacts: z.array(z.uuid()).default([]),
  collaboration: z
    .object({ open: z.boolean(), contactId: z.uuid().nullable() })
    .default({ open: false, contactId: null }),
  members: z.array(memberSchema),
  requests: z.array(requestSchema),
  events: z.array(eventSchema),
  notes: z.string().nullable(),
  canEdit: z.boolean(),
  canSubmit: z.boolean(),
  canManage: z.boolean(),
  operator: z.boolean(),
})
export const dashboardSchema = z.object({
  operator: z.boolean(),
  associations: z.array(summarySchema),
  requests: z.array(requestSchema.extend({ associationId: z.uuid(), associationName: z.string() })),
})
export const directoryEntrySchema = z.object({
  id: z.uuid(),
  name: z.string(),
  revision: z.number(),
  acronym: z.string().default(""),
  programmes: z.array(catalogueSlug).default([]),
  campuses: z.array(catalogueSlug).default([]),
  crossProgramme: z.boolean().default(false),
  /** Only the contacts the viewer may see: public ones for everyone, `associations` for other active associations. */
  contacts: z.array(contactSchema).default([]),
  /** Open to collaborations, with the dedicated contact when the viewer may see it. */
  collaboration: z
    .object({ open: z.boolean(), contactId: z.uuid().nullable() })
    .default({ open: false, contactId: null }),
})
export const directorySchema = z.array(directoryEntrySchema)
export const catalogueSchema = z.array(catalogueEntrySchema)
export const refSchema = z.object({ id: z.uuid() })
export const createSchema = z.object({
  profile: profileSchema,
  explanation: reason,
  submit: z.boolean(),
  commandId: z.uuid(),
})
const base = { id: z.uuid(), revision: z.number().int().nonnegative(), commandId: z.uuid() }
export const commandSchema = z.discriminatedUnion("action", [
  z.object({
    ...base,
    action: z.literal("save"),
    requestId: z.uuid().nullable(),
    profile: profileSchema,
    explanation: text,
  }),
  z.object({ ...base, action: z.literal("submit"), requestId: z.uuid() }),
  z.object({ ...base, action: z.literal("reply"), requestId: z.uuid(), explanation: reason }),
  z.object({ ...base, action: z.literal("withdraw"), requestId: z.uuid() }),
  z.object({ ...base, action: z.literal("access"), explanation: reason }),
  z.object({ ...base, action: z.literal("invite"), email: z.email().max(320), role: roleSchema, explanation: reason }),
  z.object({
    ...base,
    action: z.literal("membership"),
    sub: z.string().min(1).max(200),
    role: roleSchema,
    remove: z.boolean(),
    explanation: reason,
  }),
  z.object({ ...base, action: z.literal("redirect"), requestId: z.uuid(), destinationId: z.uuid(), reason }),
  z.object({
    ...base,
    action: z.literal("review"),
    requestId: z.uuid(),
    decision: z.enum(["approve", "changes", "reject"]),
    reason,
  }),
  z.object({
    ...base,
    action: z.literal("status"),
    status: z.enum(["active", "suspended", "archived"]),
    hide: z.boolean(),
    reason,
  }),
  z.object({ ...base, action: z.literal("unpublish"), reason }),
  z.object({ ...base, action: z.literal("note"), note: text }),
  // Non-public contacts are saved at once; public ones go into the working profile, which the responsible submits.
  z.object({ ...base, action: z.literal("contacts"), contacts: z.array(contactSchema).max(40) }),
  z.object({ ...base, action: z.literal("collaboration"), open: z.boolean(), contactId: z.uuid().nullable() }),
  z.object({ ...base, action: z.literal("leave"), reason }),
  z.object({ ...base, action: z.literal("revoke"), sub: z.string().min(1).max(200), reason }),
])
export const inviteSchema = z.object({ token: z.string().min(32).max(128) })
export const invitationSchema = z.object({ associationName: z.string(), role: roleSchema, expiresAt: z.string() })
// Promotion requests. Channels follow the RRI (art. 4.7): the PoliAssociazioni channel, a course's broadcast channel,
// one exam or cohort group, a general group of a level, every group of a course, or another case PoliNetwork evaluates.
export const promotionStatus = z.enum([
  "draft",
  "submitted",
  "changes_requested",
  "approved",
  "scheduled",
  "published",
  "rejected",
  "withdrawn",
])
export const promotionChannel = z.enum([
  "poliassociazioni",
  "course_broadcast",
  "exam_group",
  "level_group",
  "course_groups",
  "other",
])
/** Channels aimed at one degree programme's groups. */
export const programmeChannels: readonly z.infer<typeof promotionChannel>[] = [
  "course_broadcast",
  "exam_group",
  "course_groups",
]
const isoDate = z.iso.date()
export const promotionChannelRequestSchema = z.object({
  channel: promotionChannel,
  programme: catalogueSlug.nullable().default(null),
  // Which exam or cohort group, which level, or what the "other" case is.
  note: z.string().trim().max(300).default(""),
})
export const promotionContentSchema = z.object({
  title: z.string().trim().max(200),
  text: z.string().trim().max(5000),
  link: z.union([z.literal(""), httpUrl]),
  poster: httpUrl.nullable(),
  channels: z.array(promotionChannelRequestSchema).max(12),
  audience: z.object({
    everyone: z.boolean(),
    programmes: z.array(catalogueSlug).max(40),
    campuses: z.array(catalogueSlug).max(20),
  }),
  desiredDate: isoDate.nullable(),
  deadline: isoDate.nullable(),
  /** The calendar event this request promotes, if it was created from one. */
  eventId: z.uuid().nullable().default(null),
})
export const promotionTransitionSchema = z.object({
  id: z.uuid(),
  kind: z.enum(["transition", "comment"]),
  from: promotionStatus.nullable(),
  to: promotionStatus.nullable(),
  at: z.string(),
  actorName: z.string(),
  note: z.string(),
  /** Operator-only notes; never sent to representatives. */
  internal: z.boolean(),
})
export const promotionSchema = z.object({
  id: z.uuid(),
  associationId: z.uuid(),
  associationName: z.string(),
  status: promotionStatus,
  revision: z.number().int(),
  content: promotionContentSchema,
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  scheduledAt: z.string().nullable(),
  scheduledChannel: promotionChannel.nullable(),
  scheduledDetail: z.string(),
  publishedUrl: z.string().nullable(),
  publishedAt: z.string().nullable(),
  transitions: z.array(promotionTransitionSchema),
  canEdit: z.boolean(),
  canSubmit: z.boolean(),
  canWithdraw: z.boolean(),
  operator: z.boolean(),
})
export const promotionListSchema = z.array(promotionSchema)
export const promotionQueueSchema = z.object({
  status: promotionStatus.optional(),
  /** Desired or scheduled date, inclusive. */
  from: isoDate.optional(),
  to: isoDate.optional(),
})
export const promotionCreateSchema = z.object({
  associationId: z.uuid(),
  content: promotionContentSchema,
  commandId: z.uuid(),
})
const promotionBase = { id: z.uuid(), revision: z.number().int().nonnegative(), commandId: z.uuid() }
export const promotionCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...promotionBase, action: z.literal("save"), content: promotionContentSchema }),
  z.object({ ...promotionBase, action: z.literal("submit") }),
  z.object({ ...promotionBase, action: z.literal("withdraw"), note: text }),
  z.object({ ...promotionBase, action: z.literal("comment"), note: reason, internal: z.boolean() }),
  z.object({ ...promotionBase, action: z.literal("changes"), note: reason }),
  z.object({ ...promotionBase, action: z.literal("approve"), note: text }),
  z.object({ ...promotionBase, action: z.literal("reject"), note: reason }),
  z.object({
    ...promotionBase,
    action: z.literal("schedule"),
    scheduledAt: z.iso.datetime({ offset: true }),
    channel: promotionChannel,
    detail: z.string().trim().max(300),
    note: text,
  }),
  z.object({ ...promotionBase, action: z.literal("publish"), url: httpUrl, note: text }),
])
export type PromotionContent = z.infer<typeof promotionContentSchema>
export type PromotionCommand = z.infer<typeof promotionCommandSchema>
export type PromotionStatus = z.infer<typeof promotionStatus>
export type PromotionTransition = z.infer<typeof promotionTransitionSchema>
// Events for the shared calendar: public only after an operator approves them.
export const eventStatus = z.enum(["draft", "submitted", "changes_requested", "approved", "rejected", "withdrawn"])
export const calendarEventContentSchema = z.object({
  title: z.string().trim().max(200),
  descriptionIt: z.string().trim().max(5000),
  descriptionEn: z.string().trim().max(5000),
  startsAt: z.iso.datetime({ offset: true }).nullable(),
  endsAt: z.iso.datetime({ offset: true }).nullable(),
  online: z.boolean(),
  venue: z.string().trim().max(300),
  campus: catalogueSlug.nullable(),
  link: z.union([z.literal(""), httpUrl]),
  poster: httpUrl.nullable(),
})
export const calendarEventSchema = z.object({
  id: z.uuid(),
  associationId: z.uuid(),
  associationName: z.string(),
  status: eventStatus,
  revision: z.number().int(),
  content: calendarEventContentSchema,
  createdByName: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  transitions: z.array(promotionTransitionSchema.extend({ from: eventStatus.nullable(), to: eventStatus.nullable() })),
  canEdit: z.boolean(),
  canSubmit: z.boolean(),
  canWithdraw: z.boolean(),
  operator: z.boolean(),
})
export const calendarEventListSchema = z.array(calendarEventSchema)
export const calendarEventQueueSchema = z.object({
  status: eventStatus.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
})
export const calendarEventCreateSchema = z.object({
  associationId: z.uuid(),
  content: calendarEventContentSchema,
  commandId: z.uuid(),
})
export const calendarEventCommandSchema = z.discriminatedUnion("action", [
  z.object({ ...promotionBase, action: z.literal("save"), content: calendarEventContentSchema }),
  z.object({ ...promotionBase, action: z.literal("submit") }),
  z.object({ ...promotionBase, action: z.literal("withdraw"), note: text }),
  z.object({ ...promotionBase, action: z.literal("comment"), note: reason, internal: z.boolean() }),
  z.object({ ...promotionBase, action: z.literal("changes"), note: reason }),
  z.object({ ...promotionBase, action: z.literal("approve"), note: text }),
  z.object({ ...promotionBase, action: z.literal("reject"), note: reason }),
])
/** Whether the association is open to collaborations, and which of its contacts to write to. */
export const collaborationSchema = z.object({ open: z.boolean(), contactId: z.uuid().nullable() })
export type CalendarEventContent = z.infer<typeof calendarEventContentSchema>
export type CalendarEventCommand = z.infer<typeof calendarEventCommandSchema>
export type EventStatus = z.infer<typeof eventStatus>
export type Collaboration = z.infer<typeof collaborationSchema>

// The portal home: what needs the viewer's attention, computed on the server. `kind` is open (a newer backend may add
// kinds the admin renders generically); `homeActionKinds` lists the ones this version produces.
export const homeActionKinds = [
  "request_changes",
  "profile_changes",
  "profile_draft",
  "contacts_to_publish",
  "stale_contacts",
  "profile_unpublished",
  "promotion_changes",
  "promotion_to_submit",
  "promotion_draft",
  "promotion_scheduled",
  "promotion_published",
  "event_changes",
  "event_to_submit",
  "event_draft",
] as const
export const homeSchema = z.object({
  operator: z.boolean(),
  actions: z.array(
    z.object({
      kind: z.string(),
      associationId: z.uuid(),
      associationName: z.string(),
      /** The request, promotion or event the action is about. */
      targetId: z.string().nullable(),
      /** Its title, or the labels of the contacts to update. */
      title: z.string(),
      at: z.string().nullable(),
      urgent: z.boolean(),
    })
  ),
  /** Operators only: items waiting in each queue. */
  counters: z
    .object({
      profiles: z.number().int(),
      access: z.number().int(),
      promotions: z.number().int(),
      events: z.number().int(),
      handovers: z.number().int(),
    })
    .nullable(),
})
export type Profile = z.infer<typeof profileSchema>
export type Request = z.infer<typeof requestSchema>
export type Detail = z.infer<typeof detailSchema>
export type Command = z.infer<typeof commandSchema>
export type Member = z.infer<typeof memberSchema>
export type Event = z.infer<typeof eventSchema>
export type Contact = z.infer<typeof contactSchema>
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>
