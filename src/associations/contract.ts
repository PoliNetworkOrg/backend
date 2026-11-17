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
export const profileSchema = z.object({
  name: z.string().trim().min(1).max(200),
  acronym: z.string().trim().max(50),
  descriptionIt: text,
  descriptionEn: text,
  logo: httpUrl.nullable(),
  email: z.union([z.literal(""), z.email().max(320)]),
  links: z.array(linkSchema).max(30),
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
export const directorySchema = z.array(z.object({ id: z.uuid(), name: z.string(), revision: z.number() }))
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
  z.object({ ...base, action: z.literal("leave"), reason }),
  z.object({ ...base, action: z.literal("revoke"), sub: z.string().min(1).max(200), reason }),
])
export const inviteSchema = z.object({ token: z.string().min(32).max(128) })
export const invitationSchema = z.object({ associationName: z.string(), role: roleSchema, expiresAt: z.string() })
export type Profile = z.infer<typeof profileSchema>
export type Request = z.infer<typeof requestSchema>
export type Detail = z.infer<typeof detailSchema>
export type Command = z.infer<typeof commandSchema>
export type Member = z.infer<typeof memberSchema>
export type Event = z.infer<typeof eventSchema>
