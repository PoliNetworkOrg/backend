import { z } from "zod"

/**
 * Wire contract of the admin dashboard's People area (PoliNetworkOrg/admin).
 * The admin parses responses against these shapes. Keep input/output changes coordinated with that repository.
 */

/**
 * The teams People knows. A team can only be assigned once PoliNetwork Auth binds a role to it
 * (`team:<id>:member` / `team:<id>:lead`); see `TeamSummary.assignable`.
 */
export const TEAM_IDS = ["it", "hr", "design", "events"] as const

export const teamIdSchema = z.enum(TEAM_IDS)
export type TeamId = z.infer<typeof teamIdSchema>

const personRefSchema = z.object({ id: z.string(), name: z.string() })
export type PersonRef = z.infer<typeof personRefSchema>

export const ASSIGNMENT_KINDS = ["admin", "capo", "team"] as const
export const TEAM_ROLES = ["member", "lead"] as const
/**
 * Where an assignment stands with PoliNetwork Auth:
 * - `pending`: the record is not linked to a login account, so Auth knows nothing of it yet;
 * - `sent`: the change was sent to Auth, which has not confirmed it yet;
 * - `applied`: Auth holds it (or, for an ending, no longer holds it);
 * - `refused`: Auth refused the change; `refusal` says why.
 */
export const ASSIGNMENT_STATUSES = ["pending", "sent", "applied", "refused"] as const

export const teamFieldsSchema = z.record(z.string(), z.union([z.string(), z.array(z.string())]))
/** The team-specific fields a dashboard write may send: a handful of short keys and values. */
const teamFieldsInput = z
  .record(z.string().min(1).max(40), z.union([z.string().trim().max(200), z.array(z.string().trim().max(60)).max(20)]))
  .refine((fields) => Object.keys(fields).length <= 10, "Too many fields.")

/** Group Admin, Capo Admin, or member or Lead of a team. */
export const assignmentSchema = z.object({
  id: z.string(),
  kind: z.enum(ASSIGNMENT_KINDS),
  /** Set for `team`. */
  team: teamIdSchema.nullable(),
  /** Set for `team`. */
  teamRole: z.enum(TEAM_ROLES).nullable(),
  /** Set for `capo`, e.g. "Ingegneria Informatica". */
  capoScope: z.string().nullable(),
  /** Set for `admin`: the Capo Admin this admin answers to. */
  capoOfReference: personRefSchema.nullable(),
  /** Team-specific fields, for `team`. */
  fields: teamFieldsSchema,
  since: z.string(),
  /** `null` while current. */
  endedOn: z.string().nullable(),
  endReason: z.string().nullable(),
  /** The account that made the assignment, or `auth` when it was made by hand in PoliNetwork Auth. */
  assignedBy: z.string(),
  /** Whether `status` is about starting or ending it. */
  change: z.enum(["start", "end"]),
  status: z.enum(ASSIGNMENT_STATUSES),
  /** Why PoliNetwork Auth refused the change, when `status` is `refused`. */
  refusal: z.string().nullable(),
})
export type Assignment = z.infer<typeof assignmentSchema>

export const accountSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("none") }),
  z.object({
    status: z.literal("invite"),
    email: z.string(),
    sentOn: z.string(),
    expiresOn: z.string(),
    sentBy: z.string(),
  }),
  z.object({
    status: z.literal("linked"),
    sub: z.string(),
    /** `auth` for a record People created for a role given by hand in PoliNetwork Auth. */
    method: z.enum(["invite", "manual", "auth"]),
    linkedOn: z.string().nullable(),
    /** Who linked it: the invitee for an invite, `auth` for a record created from Auth. */
    linkedBy: z.string().nullable(),
  }),
])
export type Account = z.infer<typeof accountSchema>

/** Where a person studies or works from. `external`: not a Politecnico student. */
export const CAMPUS_IDS = ["leonardo", "bovisa", "lecco", "cremona", "mantova", "piacenza", "external"] as const
export const campusSchema = z.enum(CAMPUS_IDS)
export type CampusId = z.infer<typeof campusSchema>
export const CAMPUSES = {
  leonardo: "Leonardo",
  bovisa: "Bovisa",
  lecco: "Lecco",
  cremona: "Cremona",
  mantova: "Mantova",
  piacenza: "Piacenza",
  external: "Esterno",
} satisfies Record<CampusId, string>

/** Politecnico's four schools. Every course belongs to exactly one: the one its official manifesto page names. */
export const SCHOOL_IDS = ["auic", "icat", "3i", "design"] as const
export const schoolIdSchema = z.enum(SCHOOL_IDS)
export type SchoolId = z.infer<typeof schoolIdSchema>
export const SCHOOLS = {
  auic: { short: "AUIC", name: "Architettura Urbanistica Ingegneria delle Costruzioni" },
  icat: { short: "ICAT", name: "Ingegneria Civile, Ambientale e Territoriale" },
  "3i": { short: "3I", name: "Ingegneria Industriale e dell'Informazione" },
  design: { short: "Design", name: "Design" },
} satisfies Record<SchoolId, { short: string; name: string }>

export const COURSE_LEVELS = ["bachelor", "master", "single-cycle"] as const

/**
 * Student representative seats. Which CCS and which school are never stored: a CCS seat is on the council of the
 * person's own course, a school seat (Giunta di Scuola included) is in their course's school.
 */
export const REPRESENTATIVE_ROLES = ["ccs", "school", "senate", "board", "other"] as const
export const representativeRoleSchema = z.enum(REPRESENTATIVE_ROLES)
export type RepresentativeRole = z.infer<typeof representativeRoleSchema>

/** A Politecnico degree course, from the official manifesti. `code` is Polimi's own course code (`k_corso_la`). */
export const courseSchema = z.object({
  code: z.number().int(),
  name: z.string(),
  level: z.enum(COURSE_LEVELS),
  school: schoolIdSchema,
  /**
   * The regulation it runs under: "96/23" for the current courses, "270" for the older ones, kept until their students
   * finish. The same degree can be listed under both, with different codes.
   */
  regulation: z.string(),
  /** As Polimi names them, e.g. "Milano Leonardo", "Cremona". */
  campuses: z.array(z.string()),
  /** As the manifesto lists them, e.g. ["Italiano"], ["Inglese"]. */
  languages: z.array(z.string()),
  /** `false` once a yearly update no longer lists it (kept: records may point to it). */
  active: z.boolean(),
})
export type Course = z.infer<typeof courseSchema>

/** One row of the People lists: everything but notes, activity and audit fields. */
export const personRowSchema = z.object({
  id: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  /** Only for sending invites, never to match accounts. `null` without contact rights. */
  contactEmail: z.string().nullable(),
  /** `null` without contact rights. */
  phone: z.string().nullable(),
  /** Informational only. */
  telegramUsername: z.string().nullable(),
  /** `none` without `people:read`, except on one's own record. */
  account: accountSchema,
  assignments: z.array(assignmentSchema),
  /** The person's course, `null` when unknown or not a student. */
  course: courseSchema.nullable(),
  campus: campusSchema.nullable(),
})

export const activitySchema = z.object({ actor: z.string(), text: z.string(), at: z.string() })

export const personRecordSchema = personRowSchema.extend({
  /** `null` without `people:read`. */
  notes: z.string().nullable(),
  /** Newest first; empty without `people:read`. */
  activity: z.array(activitySchema),
  /** Other student associations or lists, by name. Empty without `people:read`. */
  otherAssociations: z.array(z.string()),
  /** Empty when not a representative, and without `people:read`. */
  representativeRoles: z.array(representativeRoleSchema),
  /** The seat, when `representativeRoles` has `other` (e.g. "Comitato Sportivo"); `null` otherwise and without `people:read`. */
  representativeOther: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
})

export type PersonRow = z.infer<typeof personRowSchema>
export type PersonRecord = z.infer<typeof personRecordSchema>
export type Activity = z.infer<typeof activitySchema>
export type TeamFields = z.infer<typeof teamFieldsSchema>

export const adminSummarySchema = z.object({
  person: personRowSchema,
  /** The current admin assignment. */
  admin: assignmentSchema,
  /** The current Capo Admin assignment, when they are also one. */
  capo: assignmentSchema.nullable(),
})
export type AdminSummary = z.infer<typeof adminSummarySchema>

export const capoSummarySchema = z.object({
  person: personRowSchema,
  capo: assignmentSchema,
  /** Current admins who have them as Capo Admin of reference. */
  admins: z.array(personRefSchema),
})
export type CapoSummary = z.infer<typeof capoSummarySchema>

export const teamSummarySchema = z.object({
  id: teamIdSchema,
  name: z.string(),
  /** Whether PoliNetwork Auth binds a role to this team. Without one, nobody can be added. */
  assignable: z.object({ member: z.boolean(), lead: z.boolean() }),
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

/** A link made in the last 30 days, so a mistake (or a forwarded invite) is easy to spot and undo. */
export const recentLinkSchema = z.object({
  person: personRefSchema,
  sub: z.string(),
  /** The account's directory email, when the IdP lists it. */
  email: z.string().nullable(),
  method: z.enum(["invite", "manual", "auth"]),
  linkedOn: z.string(),
  linkedBy: z.string().nullable(),
})
export type RecentLink = z.infer<typeof recentLinkSchema>

/** What the invite landing page shows before the signed-in account confirms. */
export const invitePreviewSchema = z.object({ personId: z.string(), name: z.string(), expiresOn: z.string() })
export type InvitePreview = z.infer<typeof invitePreviewSchema>

export const accountMatchSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  linkedTo: personRefSchema.nullable(),
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
            role: z.enum(TEAM_ROLES),
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
    name: "Design & Marketing",
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
/** Starts the reason an unlink sends Auth, which takes at most 500 characters; the record's history keeps the rest. */
export const UNLINK_REASON = "Unlinked from People: "
const capoScopeSchema = z.string().trim().min(1).max(120)
/** Telegram's own rule: 5–32 letters, digits or underscores. Empty when unknown; a leading @ is dropped. */
export const TELEGRAM_USERNAME_PATTERN = /^@?[A-Za-z0-9_]{5,32}$/
const telegramUsernameSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || TELEGRAM_USERNAME_PATTERN.test(value), "Enter a valid Telegram username.")
  .transform((value) => value.replace(/^@/, ""))

/** Keeps the first spelling of each name, ignoring case. */
const uniqueNames = (names: string[]) =>
  names.filter((name, i) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) === i)

/**
 * A record's name, contacts and profile. The profile fields are optional: omitted, they are empty on a new record and
 * unchanged on an update, so a dashboard that predates them never erases them.
 */
export const personInputSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  /** Empty when unknown. */
  contactEmail: z.union([z.literal(""), z.email().max(254)]),
  /** Empty when unknown. */
  phone: z.string().trim().max(40),
  /** Empty when unknown. */
  telegramUsername: telegramUsernameSchema,
  /** A course from `people.courses.list`; setting one needs it to be active. */
  courseCode: z.number().int().positive().nullable().optional(),
  campus: campusSchema.nullable().optional(),
  /** Trimmed, 1–100 characters each, at most 10; a second spelling of a name, ignoring case, is dropped. */
  otherAssociations: z.array(z.string().trim().min(1).max(100)).max(10).transform(uniqueNames).optional(),
  /** `ccs` and `school` need a course. Duplicates are dropped. */
  representativeRoles: z
    .array(representativeRoleSchema)
    .max(5)
    .transform((roles) => [...new Set(roles)])
    .optional(),
  /** Required with `other`, and only with it. */
  representativeOther: z.string().trim().max(100).nullable().optional(),
})
/** The rules the input alone can check; the service checks them again on the record as it will be saved. */
function checkProfile(input: z.output<typeof personInputSchema>, ctx: z.RefinementCtx) {
  const { representativeRoles: roles, representativeOther: other } = input
  if (roles === undefined || other === undefined) return
  if (roles.includes("other") && !other)
    ctx.addIssue({ code: "custom", path: ["representativeOther"], message: "Name the other seat." })
  if (!roles.includes("other") && other)
    ctx.addIssue({ code: "custom", path: ["representativeOther"], message: "Only an Other seat takes a name." })
}
export const createPersonInputSchema = personInputSchema.superRefine(checkProfile)
export const updatePersonInputSchema = personInputSchema.extend({ id: personIdSchema }).superRefine(checkProfile)
export const setNoteInputSchema = z.object({ id: personIdSchema, note: z.string().trim().max(2000) })

export const assignAdminInputSchema = z.object({
  personId: personIdSchema,
  since: dateSchema,
  capoId: personIdSchema.nullable(),
})
export const endAssignmentInputSchema = z.object({ personId: personIdSchema, reason: reasonSchema })
export const capoRefInputSchema = z.object({ personId: personIdSchema, capoId: personIdSchema.nullable() })
export const appointCapoInputSchema = z.object({ personId: personIdSchema, since: dateSchema, scope: capoScopeSchema })
export const capoScopeInputSchema = z.object({ personId: personIdSchema, scope: capoScopeSchema })

export const addTeamMemberInputSchema = z.object({
  teamId: teamIdSchema,
  personId: personIdSchema,
  role: z.enum(TEAM_ROLES),
  since: dateSchema,
  fields: teamFieldsInput,
})
export const teamCandidatesInputSchema = z.object({ teamId: teamIdSchema })
export const teamCandidateSchema = z.object({ id: z.string(), name: z.string() })
export type TeamCandidate = z.infer<typeof teamCandidateSchema>
export const teamFieldsInputSchema = z.object({
  teamId: teamIdSchema,
  personId: personIdSchema,
  fields: teamFieldsInput,
})
export const endTeamInputSchema = z.object({
  teamId: teamIdSchema,
  personId: personIdSchema,
  reason: reasonSchema,
})

export const personRefInputSchema = z.object({ personId: personIdSchema })
export const inviteTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const inviteTokenInputSchema = z.object({ token: inviteTokenSchema })
export const unlinkAccountInputSchema = z.object({
  personId: personIdSchema,
  reason: reasonSchema.max(500 - UNLINK_REASON.length),
})
export const searchAccountsInputSchema = z.object({ query: z.string().trim().max(120) })
export const linkAccountInputSchema = z.object({
  personId: personIdSchema,
  accountId: opaqueIdSchema,
  reason: reasonSchema,
})

export type PersonInput = z.infer<typeof personInputSchema>
export type CreatePersonInput = z.infer<typeof createPersonInputSchema>
export type UpdatePersonInput = z.infer<typeof updatePersonInputSchema>
export type SetNoteInput = z.infer<typeof setNoteInputSchema>
export type AssignAdminInput = z.infer<typeof assignAdminInputSchema>
export type EndAssignmentInput = z.infer<typeof endAssignmentInputSchema>
export type CapoRefInput = z.infer<typeof capoRefInputSchema>
export type AppointCapoInput = z.infer<typeof appointCapoInputSchema>
export type CapoScopeInput = z.infer<typeof capoScopeInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type TeamFieldsInput = z.infer<typeof teamFieldsInputSchema>
export type TeamCandidatesInput = z.infer<typeof teamCandidatesInputSchema>
export type EndTeamInput = z.infer<typeof endTeamInputSchema>
export type SearchAccountsInput = z.infer<typeof searchAccountsInputSchema>
export type LinkAccountInput = z.infer<typeof linkAccountInputSchema>
export type UnlinkAccountInput = z.infer<typeof unlinkAccountInputSchema>

export const createdSchema = z.object({ id: z.string() })

/** A team's fields in display order, typed for rendering and forms. */
export function teamFields(team: TeamId): TeamField[] {
  return TEAMS[team].fields
}
