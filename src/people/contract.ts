import { z } from "zod"

/**
 * Wire contract of the admin dashboard's People area (PoliNetworkOrg/admin).
 * The admin parses responses against these shapes. Keep input/output changes coordinated with that repository.
 */

export const TEAM_IDS = ["it", "hr", "design", "intl", "events"] as const
export const CAMPUSES = ["Leonardo", "Bovisa", "Cremona", "Piacenza", "Mantova", "Lecco", "External"] as const
export const YEARS = ["1st year", "2nd year", "3rd year", "1st year MSc", "2nd year MSc", "Graduated"] as const
/** Politecnico di Milano courses offered in forms; the backend accepts any course name. */
export const COURSES = [
  "Ingegneria Informatica",
  "Computer Science and Engineering",
  "Ingegneria Gestionale",
  "Management Engineering",
  "Ingegneria Meccanica",
  "Ingegneria Aerospaziale",
  "Ingegneria Energetica",
  "Ingegneria Chimica",
  "Ingegneria Elettronica",
  "Ingegneria Biomedica",
  "Ingegneria Matematica",
  "Ingegneria Civile",
  "Design della Comunicazione",
  "Design del Prodotto Industriale",
  "Design degli Interni",
  "Architettura",
  "Urbanistica",
] as const
export const PHOTO_CONSENTS = ["granted", "denied", "revoked"] as const

export const teamIdSchema = z.enum(TEAM_IDS)
export const campusSchema = z.enum(CAMPUSES)

export type TeamId = z.infer<typeof teamIdSchema>
export type Campus = z.infer<typeof campusSchema>
export type PhotoConsent = (typeof PHOTO_CONSENTS)[number]

const personRefSchema = z.object({ id: z.string(), name: z.string() })

export const profileSchema = z.object({
  firstName: z.string(),
  lastName: z.string(),
  /** `null` without contact rights. */
  personalEmail: z.string().nullable(),
  /** `null` without contact rights. */
  phone: z.string().nullable(),
  telegramUsername: z.string().nullable(),
  telegramId: z.string().nullable(),
  course: z.string(),
  year: z.string(),
  campus: campusSchema,
  otherAssociations: z.array(z.string()),
  studentRepresentative: z.string().nullable(),
})

export const adminRoleSchema = z.object({
  status: z.enum(["active", "former"]),
  since: z.string(),
  endedOn: z.string().nullable(),
  endReason: z.string().nullable(),
  availableAsCapo: z.boolean(),
  capoOfReference: personRefSchema.nullable(),
  /** Set when this person is a Capo Admin, e.g. "Ingegneria Informatica". */
  capoScope: z.string().nullable(),
})

export const teamFieldsSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
/** The team-specific fields a dashboard write may send: a handful of short keys and values. */
const teamFieldsInput = z
  .record(z.string().min(1).max(40), z.union([z.string().trim().max(200), z.array(z.string().trim().max(60)).max(20)]))
  .refine((fields) => Object.keys(fields).length <= 10, "Too many fields.")

export const teamMembershipSchema = z.object({
  team: teamIdSchema,
  role: z.enum(["member", "lead"]),
  since: z.string(),
  endedOn: z.string().nullable(),
  endReason: z.string().nullable(),
  fields: teamFieldsSchema,
})

export const accountSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({
    status: z.literal("invite"),
    email: z.string(),
    sentOn: z.string(),
    expiresOn: z.string(),
    sentBy: z.string(),
  }),
  z.object({ status: z.literal("linked"), email: z.string(), via: z.string(), linkedOn: z.string(), how: z.string() }),
])

export const consentsSchema = z.object({
  privacy: z.object({ version: z.string(), acceptedOn: z.string() }).nullable(),
  photo: z.object({ status: z.enum(PHOTO_CONSENTS), on: z.string() }).nullable(),
})

/** One row of the People lists: everything but notes, activity and discrepancies. */
export const personRowSchema = z.object({
  id: z.string(),
  profile: profileSchema,
  admin: adminRoleSchema.nullable(),
  teams: z.array(teamMembershipSchema),
  consents: consentsSchema,
  account: accountSchema,
})

export const discrepancySchema = z.object({
  kind: z.enum(["telegram-mismatch", "needs-review"]),
  message: z.string(),
  suggestedTelegram: z.string().nullable(),
})

export const activitySchema = z.object({ actor: z.string(), text: z.string(), at: z.string() })

export const personRecordSchema = personRowSchema.extend({
  /** `null` without `people:read`. */
  notes: z.string().nullable(),
  discrepancies: z.array(discrepancySchema),
  activity: z.array(activitySchema),
})

export type Profile = z.infer<typeof profileSchema>
export type AdminRole = z.infer<typeof adminRoleSchema>
export type TeamFields = z.infer<typeof teamFieldsSchema>
export type TeamMembership = z.infer<typeof teamMembershipSchema>
export type Account = z.infer<typeof accountSchema>
export type Consents = z.infer<typeof consentsSchema>
export type PersonRow = z.infer<typeof personRowSchema>
export type PersonRecord = z.infer<typeof personRecordSchema>
export type Discrepancy = z.infer<typeof discrepancySchema>

export const teamSummarySchema = z.object({
  id: teamIdSchema,
  name: z.string(),
  lead: personRefSchema.nullable(),
  members: z.array(personRowSchema),
})
export type TeamSummary = z.infer<typeof teamSummarySchema>

export const inviteSchema = z.object({
  personId: z.string(),
  name: z.string(),
  email: z.string(),
  sentOn: z.string(),
  expiresOn: z.string(),
  sentBy: z.string(),
})
export type Invite = z.infer<typeof inviteSchema>

export const accountMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  telegram: z.string().nullable(),
  via: z.string(),
  linkedTo: personRefSchema.nullable(),
  reason: z.enum(["same-telegram", "same-email", "similar-name"]),
})
export type AccountMatch = z.infer<typeof accountMatchSchema>

export const capoAreaSchema = z.object({
  scope: z.string(),
  admins: z.array(personRowSchema),
})
export type CapoArea = z.infer<typeof capoAreaSchema>

export const myRolesSchema = z.object({
  /** The Capo Admin scope, when the signed-in person is one. */
  capoScope: z.string().nullable(),
  /** Teams the signed-in person leads. */
  leads: z.array(teamIdSchema),
})
export type MyRoles = z.infer<typeof myRolesSchema>

const contactSchema = z.object({
  role: z.enum(["capo", "lead", "hr"]),
  name: z.string(),
  telegram: z.string().nullable(),
  team: teamIdSchema.nullable(),
})

export const myAreaSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("linked"),
    person: personRecordSchema,
    contacts: z.array(contactSchema),
    roster: z
      .object({
        team: teamIdSchema,
        members: z.array(
          z.object({
            id: z.string(),
            name: z.string(),
            role: z.enum(["member", "lead"]),
            telegram: z.string().nullable(),
          })
        ),
      })
      .nullable(),
  }),
  z.object({ state: z.literal("none") }),
])
export type MyArea = z.infer<typeof myAreaSchema>

/** The team-specific fields, in display order. */
export type TeamField = { key: string; label: string; kind: "text" | "multi"; mono?: boolean; options?: string[] }

export const TEAMS = {
  it: {
    name: "IT",
    fields: [
      { key: "github", label: "GitHub", kind: "text", mono: true },
      { key: "areas", label: "Areas", kind: "multi", options: ["Frontend", "Backend", "Bot", "Infrastructure"] },
    ],
  },
  hr: {
    name: "HR",
    fields: [
      { key: "focus", label: "Focus", kind: "multi", options: ["Recruiting", "Onboarding", "Census", "Wellbeing"] },
    ],
  },
  design: {
    name: "Design & Social",
    fields: [
      {
        key: "tools",
        label: "Tools",
        kind: "multi",
        options: ["Figma", "Illustrator", "Photoshop", "After Effects", "InDesign", "Premiere"],
      },
      { key: "portfolio", label: "Portfolio", kind: "text" },
    ],
  },
  intl: {
    name: "International",
    fields: [
      {
        key: "languages",
        label: "Languages",
        kind: "multi",
        options: ["English", "Spanish", "French", "German", "Chinese", "Portuguese"],
      },
    ],
  },
  events: {
    name: "Events & Partnerships",
    fields: [
      {
        key: "focus",
        label: "Focus",
        kind: "multi",
        options: ["Partnerships", "Logistics", "Sponsorships", "Communication"],
      },
    ],
  },
} satisfies Record<TeamId, { name: string; fields: TeamField[] }>

// Inputs. The server functions validate with these, and the fake and real APIs take the parsed values.

export const personIdSchema = z.string().regex(/^P-\d{4}$/)
const dateSchema = z.iso.date()
const opaqueIdSchema = z.string().min(1).max(128)
const reasonSchema = z.string().trim().min(1).max(500)
/** Telegram's own rule: 5–32 letters, digits or underscores. Empty when unknown; a leading @ is dropped. */
export const TELEGRAM_USERNAME_PATTERN = /^@?[A-Za-z0-9_]{5,32}$/
const telegramUsernameSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || TELEGRAM_USERNAME_PATTERN.test(value), "Enter a valid Telegram username.")
  .transform((value) => value.replace(/^@/, ""))

export const personInputSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  personalEmail: z.email().max(254),
  phone: z.string().trim().max(40),
  telegramUsername: telegramUsernameSchema,
  course: z.string().trim().min(1).max(120),
  year: z.enum(YEARS),
  campus: campusSchema,
})
export const createPersonInputSchema = personInputSchema.extend({ admin: z.boolean() })
export const updatePersonInputSchema = personInputSchema.extend({ id: personIdSchema })
export const setNoteInputSchema = z.object({ id: personIdSchema, note: z.string().trim().max(2000) })

export const endAdminInputSchema = z.object({ personId: personIdSchema, reason: reasonSchema })
export const capoScopeInputSchema = z.object({ personId: personIdSchema, scope: z.string().trim().max(120).nullable() })
export const capoRefInputSchema = z.object({ personId: personIdSchema, capoId: personIdSchema.nullable() })

export const addTeamMemberInputSchema = z.object({
  teamId: teamIdSchema,
  personId: personIdSchema,
  role: z.enum(["member", "lead"]),
  since: dateSchema,
  fields: teamFieldsInput,
})
export const teamCandidatesInputSchema = z.object({ teamId: teamIdSchema })
export const teamCandidateSchema = z.object({ id: z.string(), name: z.string(), course: z.string() })
export type TeamCandidate = z.infer<typeof teamCandidateSchema>
export const teamFieldsInputSchema = z.object({
  teamId: teamIdSchema,
  personId: personIdSchema,
  fields: teamFieldsInput,
})
export const endTeamInputSchema = z.object({
  teamId: teamIdSchema,
  personId: personIdSchema,
  lastDay: dateSchema,
  reason: reasonSchema,
  note: z.string().trim().max(500),
})

export const personRefInputSchema = z.object({ personId: personIdSchema })
export const searchAccountsInputSchema = z.object({ personId: personIdSchema, query: z.string().trim().max(120) })
export const linkAccountInputSchema = z.object({
  personId: personIdSchema,
  accountId: opaqueIdSchema,
  reason: reasonSchema,
})

export type CreatePersonInput = z.infer<typeof createPersonInputSchema>
export type UpdatePersonInput = z.infer<typeof updatePersonInputSchema>
export type SetNoteInput = z.infer<typeof setNoteInputSchema>
export type EndAdminInput = z.infer<typeof endAdminInputSchema>
export type CapoScopeInput = z.infer<typeof capoScopeInputSchema>
export type CapoRefInput = z.infer<typeof capoRefInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type TeamFieldsInput = z.infer<typeof teamFieldsInputSchema>
export type TeamCandidatesInput = z.infer<typeof teamCandidatesInputSchema>
export type EndTeamInput = z.infer<typeof endTeamInputSchema>
export type SearchAccountsInput = z.infer<typeof searchAccountsInputSchema>
export type LinkAccountInput = z.infer<typeof linkAccountInputSchema>

export const createdSchema = z.object({ id: z.string() })

/** A team's fields in display order, typed for rendering and forms. */
export function teamFields(team: TeamId): TeamField[] {
  return TEAMS[team].fields
}
