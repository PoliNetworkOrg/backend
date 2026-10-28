import { z } from "zod"

/**
 * Wire contract copied from PoliNetworkOrg/admin PR #100, commit 9d0c60b3ea7b57b9e4d97a8e2d53dadd7b098e89.
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
export const MEMBER_STATUSES = ["active", "suspended", "expired", "former"] as const
export const FEE_STATUSES = ["due", "receipt", "paid", "unpaid"] as const
export const ACCOUNT_STATUSES = ["none", "invite", "linked", "review"] as const
export const CENSUS_ANSWERS = ["continues", "leaving"] as const
export const REVIEW_KINDS = [
  "telegram-conflict",
  "ask-to-be-added",
  "two-records",
  "not-me",
  "name-only",
  "preliminary-link",
] as const
/** A receipt's pipeline: issued unsigned, signed by an officer, emailed to the member; or the email failed, or voided. */
export const RECEIPT_STATUSES = ["toSign", "signed", "sent", "failed", "voided"] as const
export const PAYMENT_METHODS = ["transfer", "cash"] as const
export const PHOTO_CONSENTS = ["granted", "denied", "revoked"] as const
/** Who signs a receipt: the President, or the Vice-president for the President's own. */
export const SIGNERS = ["president", "vicePresident"] as const

export const teamIdSchema = z.enum(TEAM_IDS)
export const campusSchema = z.enum(CAMPUSES)
export const memberStatusSchema = z.enum(MEMBER_STATUSES)
export const feeStatusSchema = z.enum(FEE_STATUSES)
export const censusAnswerSchema = z.enum(CENSUS_ANSWERS)

export type TeamId = z.infer<typeof teamIdSchema>
export type Campus = z.infer<typeof campusSchema>
export type MemberStatus = z.infer<typeof memberStatusSchema>
export type FeeStatus = z.infer<typeof feeStatusSchema>
export type CensusAnswer = z.infer<typeof censusAnswerSchema>
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export type ReviewKind = (typeof REVIEW_KINDS)[number]
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number]
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]
export type PhotoConsent = (typeof PHOTO_CONSENTS)[number]
export type Signer = (typeof SIGNERS)[number]

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
  /** Empty, like `year`, for people known only from PoliNetwork Auth or Microsoft 365 until HR completes them. */
  course: z.string(),
  year: z.string(),
  /** `null` until known: people known only from PoliNetwork Auth or Microsoft 365. */
  campus: campusSchema.nullable(),
  otherAssociations: z.array(z.string()),
  studentRepresentative: z.string().nullable(),
})

export const membershipSchema = z.object({
  number: z.string(),
  status: memberStatusSchema,
  admittedOn: z.string(),
  /** The current academic year's fee; `null` for former members. */
  fee: feeStatusSchema.nullable(),
  m365Email: z.string(),
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

export const censusEntrySchema = z.object({
  year: z.string(),
  /** `null`: expected, no answer yet. */
  answer: censusAnswerSchema.nullable(),
  answeredOn: z.string().nullable(),
  source: z.enum(["forms", "dashboard"]).nullable(),
  declaredMember: z.boolean().nullable(),
  reminders: z.number().int(),
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
  z.object({ status: z.literal("review"), reviewId: z.string(), issue: z.string() }),
])

export const consentsSchema = z.object({
  privacy: z.object({ version: z.string(), acceptedOn: z.string() }).nullable(),
  photo: z.object({ status: z.enum(PHOTO_CONSENTS), on: z.string() }).nullable(),
})

/** One row of the People lists: everything but notes, activity and discrepancies. */
export const personRowSchema = z.object({
  preliminary: z.boolean().optional(),
  id: z.string(),
  profile: profileSchema,
  /** `null` without `people:members:read`, except on the viewer's own record: `isMember` still says whether they are one. */
  member: membershipSchema.nullable(),
  /** A current member: `member` set and not former. Always present. */
  isMember: z.boolean(),
  admin: adminRoleSchema.nullable(),
  teams: z.array(teamMembershipSchema),
  census: z.array(censusEntrySchema),
  consents: consentsSchema,
  account: accountSchema,
})

export const discrepancySchema = z.object({
  /** `admin-removal` is only on older records: People no longer tracks which Telegram groups an admin keeps. */
  kind: z.enum(["declared-member", "telegram-mismatch", "needs-review", "admin-removal"]),
  message: z.string(),
  suggestedTelegram: z.string().nullable(),
})

export const activitySchema = z.object({ actor: z.string(), text: z.string(), at: z.string() })

/** A transfer receipt the member uploaded, waiting for an admin. */
export const feeUploadSchema = z.object({
  fileName: z.string(),
  size: z.number().int(),
  uploadedAt: z.string(),
  /** As the member declared it. */
  transferDate: z.string(),
  amountCents: z.number().int(),
})

/** The current fee year of one member: what is due, what was uploaded, rejected or paid. */
export const feeDetailSchema = z.object({
  year: z.string(),
  status: feeStatusSchema,
  amountCents: z.number().int(),
  dueOn: z.string(),
  upload: feeUploadSchema.nullable(),
  /** The last rejection, kept until the member uploads again. */
  rejection: z.object({ reason: z.string(), by: z.string(), at: z.string() }).nullable(),
  payment: z
    .object({
      paidOn: z.string(),
      method: z.enum(PAYMENT_METHODS),
      amountCents: z.number().int(),
      transferDate: z.string().nullable(),
    })
    .nullable(),
  /** The last reminder email, automatic or sent by hand. */
  lastReminder: z.string().nullable(),
})

/** Returned as `request.peopleReceipt` by eSign list/get for a system-owned fee receipt. */
export const receiptRequestSourceSchema = z.object({
  receiptId: z.string().min(1).max(128),
  number: z.string().min(1).max(40),
  year: z.string().regex(/^\d{4}\/\d{2}$/),
})
export type ReceiptRequestSource = z.infer<typeof receiptRequestSourceSchema>

export const receiptSchema = z.object({
  id: z.string(),
  /** "2026/042": the fee year's first calendar year and a sequence never reused. */
  number: z.string(),
  /** The fee year, "2026/27". */
  year: z.string(),
  person: personRefSchema,
  memberNumber: z.string(),
  amountCents: z.number().int(),
  issuedOn: z.string(),
  paidOn: z.string(),
  method: z.enum(PAYMENT_METHODS),
  transferDate: z.string().nullable(),
  status: z.enum(RECEIPT_STATUSES),
  signer: z.enum(SIGNERS),
  signedBy: z.string().nullable(),
  signedOn: z.string().nullable(),
  sentAt: z.string().nullable(),
  sentTo: z.string().nullable(),
  /** Why the last email failed, while `failed`. */
  failure: z.string().nullable(),
  voided: z.object({ reason: z.string(), by: z.string(), on: z.string() }).nullable(),
})

export const feesSchema = z.object({
  /** The current fee year; `null` for former members. */
  current: feeDetailSchema.nullable(),
  /** Every receipt issued to the person, newest first. Receipts are never deleted, only voided. */
  receipts: z.array(receiptSchema),
})

export const personRecordSchema = personRowSchema.extend({
  /** `null` without `people:read`. */
  notes: z.string().nullable(),
  discrepancies: z.array(discrepancySchema),
  activity: z.array(activitySchema),
  /** `null` when the person was never a member, or without `people:members:read` (except on their own record). */
  fees: feesSchema.nullable(),
})

export type Profile = z.infer<typeof profileSchema>
export type Membership = z.infer<typeof membershipSchema>
export type AdminRole = z.infer<typeof adminRoleSchema>
export type TeamFields = z.infer<typeof teamFieldsSchema>
export type TeamMembership = z.infer<typeof teamMembershipSchema>
export type CensusEntry = z.infer<typeof censusEntrySchema>
export type Account = z.infer<typeof accountSchema>
export type Consents = z.infer<typeof consentsSchema>
export type PersonRow = z.infer<typeof personRowSchema>
export type PersonRecord = z.infer<typeof personRecordSchema>
export type Discrepancy = z.infer<typeof discrepancySchema>
export type FeeUpload = z.infer<typeof feeUploadSchema>
export type FeeDetail = z.infer<typeof feeDetailSchema>
export type Receipt = z.infer<typeof receiptSchema>
export type Fees = z.infer<typeof feesSchema>

/** Register rows and admission candidates, without volunteer, census or account-link details. */
export const memberRegisterRowSchema = z.object({
  id: z.string(),
  profile: profileSchema.pick({ firstName: true, lastName: true, personalEmail: true }),
  member: membershipSchema.nullable(),
  account: z.object({ status: z.enum(ACCOUNT_STATUSES) }),
})
export type MemberRegisterRow = z.infer<typeof memberRegisterRowSchema>

export const teamSummarySchema = z.object({
  id: teamIdSchema,
  name: z.string(),
  lead: personRefSchema.nullable(),
  members: z.array(personRowSchema),
})
export type TeamSummary = z.infer<typeof teamSummarySchema>

export const campaignSchema = z.object({
  id: z.string(),
  year: z.string(),
  status: z.enum(["open", "closed"]),
  openedOn: z.string(),
  closesOn: z.string(),
  source: z.string(),
  expected: z.number().int(),
  continuing: z.number().int(),
  leaving: z.number().int(),
  noAnswer: z.number().int(),
})
export type Campaign = z.infer<typeof campaignSchema>

export const campaignDetailSchema = z.object({ campaign: campaignSchema, people: z.array(personRowSchema) })
export type CampaignDetail = z.infer<typeof campaignDetailSchema>

export const censusAnswersSchema = z.array(z.object({ question: z.string(), answer: z.string() }))

export const reviewSchema = z.object({
  id: z.string(),
  kind: z.enum(REVIEW_KINDS),
  since: z.string(),
  account: z.object({ name: z.string(), email: z.string(), telegram: z.string().nullable(), via: z.string() }),
  record: personRefSchema.nullable(),
  other: personRefSchema.nullable(),
  message: z.string().nullable(),
})
export type Review = z.infer<typeof reviewSchema>

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

const importRowSchema = z.object({
  row: z.number().int(),
  name: z.string(),
  detail: z.string(),
  answer: censusAnswerSchema.nullable(),
})
export const IMPORT_TABS = [
  "newPeople",
  "updates",
  "duplicates",
  "invalid",
  "discrepancies",
  "alreadyImported",
] as const
export type ImportTab = (typeof IMPORT_TABS)[number]

export const importPreviewSchema = z.object({
  importId: z.string(),
  fileName: z.string(),
  rows: z.number().int(),
  counts: z.object({
    newPeople: z.number().int(),
    updates: z.number().int(),
    duplicates: z.number().int(),
    invalid: z.number().int(),
    discrepancies: z.number().int(),
    alreadyImported: z.number().int(),
    leaving: z.number().int(),
  }),
  tabs: z.object({
    newPeople: z.array(importRowSchema),
    updates: z.array(importRowSchema),
    duplicates: z.array(importRowSchema),
    invalid: z.array(importRowSchema),
    discrepancies: z.array(importRowSchema),
    alreadyImported: z.array(importRowSchema),
  }),
  duplicates: z.array(
    z.object({
      pairId: z.string(),
      row: z.number().int(),
      recordId: z.string(),
      fields: z.array(z.object({ label: z.string(), file: z.string(), record: z.string(), mono: z.boolean() })),
    })
  ),
  telegram: z.array(
    z.object({
      rowId: z.string(),
      name: z.string(),
      username: z.string(),
      suggestion: z.object({ telegramId: z.string(), name: z.string(), info: z.string() }).nullable(),
    })
  ),
})
export type ImportPreview = z.infer<typeof importPreviewSchema>

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
  email: z.string().nullable(),
  team: teamIdSchema.nullable(),
})

/** How a member pays: the bank details and the reference to write on the transfer. */
export const feeInstructionsSchema = z.object({
  beneficiary: z.string(),
  iban: z.string(),
  reference: z.string(),
})
export type FeeInstructions = z.infer<typeof feeInstructionsSchema>

export const myAreaSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("linked"),
    person: personRecordSchema,
    /** Set while the signed-in person is a current member. */
    feeInstructions: feeInstructionsSchema.nullable(),
    campaign: z.object({ id: z.string(), year: z.string(), closesOn: z.string() }).nullable(),
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
            email: z.string().nullable(),
          })
        ),
      })
      .nullable(),
  }),
  z.object({
    state: z.literal("match"),
    candidate: z.object({
      id: z.string(),
      name: z.string(),
      course: z.string(),
      year: z.string(),
      campus: campusSchema.nullable(),
      roles: z.array(z.string()),
    }),
    reason: z.string(),
  }),
  z.object({
    /** People already holds a record made before this account's first sign-in; a Master Admin decides the link. */
    state: z.literal("awaiting-approval"),
    /** Only when a verified email or Telegram account matched: weaker matches may be someone else's record. */
    candidate: z.object({ id: z.string(), name: z.string(), roles: z.array(z.string()) }).nullable(),
    reason: z.string(),
  }),
  z.object({ state: z.literal("none"), request: z.object({ sentOn: z.string() }).nullable() }),
])
export type MyArea = z.infer<typeof myAreaSchema>

/** People › Receipts: one fee year's receipts and who signs them. */
export const receiptsPageSchema = z.object({
  year: z.string(),
  /** Fee years with receipts, newest first. */
  years: z.array(z.string()),
  /** The signed-in person's office, when they hold `people:receipts:sign`; `null` otherwise. */
  viewerSigner: z.enum(SIGNERS).nullable(),
  officers: z.object({ president: personRefSchema.nullable(), vicePresident: personRefSchema.nullable() }),
  receipts: z.array(receiptSchema),
})
export type ReceiptsPage = z.infer<typeof receiptsPageSchema>

/** What Review receipt shows: the member and their current fee year. */
export const feeReviewSchema = z.object({
  person: personRefSchema,
  memberNumber: z.string(),
  m365Email: z.string(),
  fee: feeDetailSchema,
  /** Earlier rejections this fee year, newest first. */
  rejections: z.array(z.object({ reason: z.string(), by: z.string(), at: z.string() })),
  /** The number approving would issue. */
  nextReceipt: z.string(),
})
export type FeeReview = z.infer<typeof feeReviewSchema>

/** A file passed through JSON: an uploaded transfer receipt, a receipt PDF or a ZIP of them. */
export const fileSchema = z.object({ fileName: z.string(), contentType: z.string(), base64: z.string() })
export type FilePayload = z.infer<typeof fileSchema>

/** Signed files read by the backend, before anything is saved or sent. */
export const signedUploadSchema = z.object({
  uploadId: z.string(),
  files: z.array(
    z.object({
      fileId: z.string(),
      fileName: z.string(),
      size: z.number().int(),
      /** Matched by the receipt number in the file name; `null` when there is none, or no such receipt. */
      receiptId: z.string().nullable(),
      /** A valid digital signature (PAdES in the PDF, or a CAdES .p7m envelope) and the name on its certificate. */
      signature: z.object({ valid: z.boolean(), signer: z.string().nullable() }),
    })
  ),
})
export type SignedUpload = z.infer<typeof signedUploadSchema>

export const sendResultSchema = z.object({ sent: z.number().int(), failed: z.number().int() })
export const issuedSchema = z.object({ receipt: z.string() })

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
const academicYearSchema = z.string().regex(/^\d{4}\/\d{2}$/)
const reasonSchema = z.string().trim().min(1).max(500)
/** Telegram's own rule: 5–32 letters, digits or underscores. Empty when unknown; a leading @ is dropped. */
export const TELEGRAM_USERNAME_PATTERN = /^@?[A-Za-z0-9_]{5,32}$/
const telegramUsernameSchema = z
  .string()
  .trim()
  .refine((value) => value === "" || TELEGRAM_USERNAME_PATTERN.test(value), "Enter a valid Telegram username.")
  .transform((value) => value.replace(/^@/, ""))
/** Import decisions are keyed by the preview's own row and pair IDs. */
const importDecisionKey = z.string().min(1).max(64)
const MAX_IMPORT_ROWS = 5000

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
export const createPersonInputSchema = personInputSchema.extend({
  requestId: z.uuid().optional(),
  personalEmail: z.union([z.literal(""), z.email().max(254)]).default(""),
  phone: z.string().trim().max(40).default(""),
  telegramUsername: telegramUsernameSchema.default(""),
  telegramId: z.union([z.literal(""), z.string().regex(/^[1-9]\d{0,19}$/)]).default(""),
  course: z.string().trim().max(120).default(""),
  year: z.union([z.literal(""), z.enum(YEARS)]).default(""),
  campus: campusSchema.nullable().default(null),
  admin: z.boolean().default(false),
  teams: z.array(teamIdSchema).max(TEAM_IDS.length).default([]),
})
export const updatePersonInputSchema = createPersonInputSchema
  .omit({ admin: true, teams: true, telegramId: true, requestId: true })
  .extend({ id: personIdSchema })
export const setNoteInputSchema = z.object({ id: personIdSchema, note: z.string().trim().max(2000) })

export const createMemberInputSchema = z.object({
  personId: personIdSchema,
  number: z.string().regex(/^\d{4}$/),
  admittedOn: dateSchema,
  fee: z.enum(["due", "paid"]),
})
export const memberStatusInputSchema = z.object({
  personId: personIdSchema,
  status: memberStatusSchema,
  reason: z.string().trim().max(500),
})
export const memberNumberInputSchema = z.object({ personId: personIdSchema, number: z.string().regex(/^\d{4}$/) })

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

export const campaignInputSchema = z.object({ campaignId: opaqueIdSchema })
export const remindInputSchema = z.object({ campaignId: opaqueIdSchema, personId: personIdSchema.nullable() })
export const answersInputSchema = z.object({ personId: personIdSchema, year: academicYearSchema })
export const importCommitInputSchema = z.object({
  importId: opaqueIdSchema,
  duplicates: z
    .record(importDecisionKey, z.enum(["same", "different"]))
    .refine((choices) => Object.keys(choices).length <= MAX_IMPORT_ROWS, "Too many decisions."),
  telegram: z
    .record(importDecisionKey, z.string().max(64).nullable())
    .refine((choices) => Object.keys(choices).length <= MAX_IMPORT_ROWS, "Too many decisions."),
})

export const resolveReviewInputSchema = z.object({
  reviewId: opaqueIdSchema,
  resolution: z.string().min(1).max(64),
  reason: reasonSchema,
})
export const reviewInputSchema = z.object({ reviewId: opaqueIdSchema })
export const personRefInputSchema = z.object({ personId: personIdSchema })
export const searchAccountsInputSchema = z.object({ personId: personIdSchema, query: z.string().trim().max(120) })
export const linkAccountInputSchema = z.object({
  personId: personIdSchema,
  accountId: opaqueIdSchema,
  reason: reasonSchema,
})

export const askToBeAddedInputSchema = z.object({
  roles: z
    .array(z.enum(["admin", "team", "member"]))
    .min(1)
    .max(3),
  groupsOrTeam: z.string().trim().max(200),
  telegramUsername: telegramUsernameSchema,
})
export const answerCensusInputSchema = z.object({
  answer: censusAnswerSchema,
  course: z.string().trim().min(1).max(120),
  year: z.enum(YEARS),
  campus: campusSchema,
  keepTeams: z.array(teamIdSchema).max(TEAM_IDS.length),
  reason: z.string().trim().max(200),
  note: z.string().trim().max(500),
})
export const CORRECTION_FIELDS = [
  "Personal email",
  "Phone",
  "Telegram username",
  "Course",
  "Year",
  "Campus",
  "Something else",
] as const
export type CorrectionField = (typeof CORRECTION_FIELDS)[number]
export const correctionInputSchema = z.object({
  field: z.enum(CORRECTION_FIELDS),
  value: z.string().trim().min(1).max(200),
  note: z.string().trim().max(500),
})

export const feePersonInputSchema = z.object({ personId: personIdSchema })
export const rejectFeeInputSchema = z.object({ personId: personIdSchema, reason: reasonSchema })
/** Amounts in cents: the fee is small, so anything above €1,000 is a typo. */
const amountCentsSchema = z.number().int().min(1).max(100_000)
export const markPaidInputSchema = z.object({
  personId: personIdSchema,
  paidOn: dateSchema,
  amountCents: amountCentsSchema,
  method: z.enum(PAYMENT_METHODS),
  note: z.string().trim().max(500),
})
export const feeRemindInputSchema = z.object({ personId: personIdSchema.nullable() })
const receiptIdSchema = z.string().min(1).max(40)
/** The existing eSign agent accepts at most ten documents with one PIN. */
export const RECEIPT_SIGN_BATCH = 10
export const prepareReceiptSignaturesInputSchema = z.object({
  receiptIds: z
    .array(receiptIdSchema)
    .min(1)
    .max(RECEIPT_SIGN_BATCH)
    .refine((ids) => new Set(ids).size === ids.length, "Choose each receipt once."),
})
export const receiptSignaturesSchema = z
  .array(
    z.object({
      receiptId: receiptIdSchema,
      requestId: z.uuid(),
      title: z.string().min(1).max(300),
    })
  )
  .min(1)
  .max(RECEIPT_SIGN_BATCH)
  .refine(
    (items) =>
      new Set(items.map((item) => item.receiptId)).size === items.length &&
      new Set(items.map((item) => item.requestId)).size === items.length,
    "Each receipt must have its own signature request."
  )
export type PrepareReceiptSignaturesInput = z.infer<typeof prepareReceiptSignaturesInputSchema>
export type ReceiptSignature = z.infer<typeof receiptSignaturesSchema>[number]

export const receiptInputSchema = z.object({ receiptId: receiptIdSchema })
export const voidReceiptInputSchema = z.object({ receiptId: receiptIdSchema, reason: reasonSchema })
export const receiptsInputSchema = z.object({
  year: z
    .string()
    .regex(/^\d{4}\/\d{2}$/)
    .nullable(),
})
/** At most one batch of signed files per upload. */
export const MAX_SIGNED_FILES = 100
export const sendSignedInputSchema = z.object({
  uploadId: z.string().min(1).max(64),
  /** File → receipt, after the matches were checked and corrected. */
  assignments: z
    .record(z.string().min(1).max(64), receiptIdSchema)
    .refine((choices) => Object.keys(choices).length <= MAX_SIGNED_FILES, "Too many files."),
})
export const transferInputSchema = z.object({ transferDate: dateSchema, amountCents: amountCentsSchema })

export type CreatePersonInput = z.input<typeof createPersonInputSchema>
export type UpdatePersonInput = z.infer<typeof updatePersonInputSchema>
export type SetNoteInput = z.infer<typeof setNoteInputSchema>
export type CreateMemberInput = z.infer<typeof createMemberInputSchema>
export type MemberStatusInput = z.infer<typeof memberStatusInputSchema>
export type MemberNumberInput = z.infer<typeof memberNumberInputSchema>
export type EndAdminInput = z.infer<typeof endAdminInputSchema>
export type CapoScopeInput = z.infer<typeof capoScopeInputSchema>
export type CapoRefInput = z.infer<typeof capoRefInputSchema>
export type AddTeamMemberInput = z.infer<typeof addTeamMemberInputSchema>
export type TeamFieldsInput = z.infer<typeof teamFieldsInputSchema>
export type TeamCandidatesInput = z.infer<typeof teamCandidatesInputSchema>
export type EndTeamInput = z.infer<typeof endTeamInputSchema>
export type RemindInput = z.infer<typeof remindInputSchema>
export type AnswersInput = z.infer<typeof answersInputSchema>
export type ImportCommitInput = z.infer<typeof importCommitInputSchema>
export type ResolveReviewInput = z.infer<typeof resolveReviewInputSchema>
export type SearchAccountsInput = z.infer<typeof searchAccountsInputSchema>
export type LinkAccountInput = z.infer<typeof linkAccountInputSchema>
export type AskToBeAddedInput = z.infer<typeof askToBeAddedInputSchema>
export type AnswerCensusInput = z.infer<typeof answerCensusInputSchema>
export type CorrectionInput = z.infer<typeof correctionInputSchema>
export type RejectFeeInput = z.infer<typeof rejectFeeInputSchema>
export type MarkPaidInput = z.infer<typeof markPaidInputSchema>
export type FeeRemindInput = z.infer<typeof feeRemindInputSchema>
export type VoidReceiptInput = z.infer<typeof voidReceiptInputSchema>
export type SendSignedInput = z.infer<typeof sendSignedInputSchema>
export type TransferInput = z.infer<typeof transferInputSchema>

export const remindResultSchema = z.object({ sent: z.number().int(), skipped: z.number().int() })
export const exportResultSchema = z.object({ filename: z.string(), csv: z.string() })
export const createdSchema = z.object({ id: z.string() })
export const importedSchema = z.object({ imported: z.number().int() })

/** A team's fields in display order, typed for rendering and forms. */
export function teamFields(team: TeamId): TeamField[] {
  return TEAMS[team].fields
}
