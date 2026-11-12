import { z } from "zod"
import { mailboxSchema } from "@/azure/mailbox"
import { codiceFiscaleProblem, matchesBirthDate, normalizeCodiceFiscale } from "./codice-fiscale"

/**
 * Wire contract of the admin dashboard's Soci area (PoliNetworkOrg/admin): the Libro Soci, one record per admission.
 * The admin parses responses against these shapes. Keep input/output changes coordinated with that repository.
 */

/** How a socio's status ended. `lapsed` is set only by the automatic lapse. */
export const END_REASONS = ["lapsed", "resigned", "expelled", "deceased", "other"] as const
/** The Microsoft 365 account behind the record. */
export const ACCOUNT_STATES = ["active", "pending_deletion", "deleted"] as const

export const memberNumberSchema = z.number().int().positive().max(999_999)

const CODICE_FISCALE_MESSAGES = {
  format: "Not a codice fiscale: 16 letters and digits in the official pattern.",
  check: "The codice fiscale's last character doesn't match: check it for typos.",
  date: "The codice fiscale encodes a birth date that doesn't exist.",
} as const

/** Upper-cased and without spaces; format, omocodia and check character validated. */
export const codiceFiscaleSchema = z
  .string()
  .transform(normalizeCodiceFiscale)
  .superRefine((code, ctx) => {
    const problem = codiceFiscaleProblem(code)
    if (problem) ctx.addIssue({ code: "custom", message: CODICE_FISCALE_MESSAGES[problem] })
  })

const dateSchema = z.iso.date()
const text = (max: number) => z.string().trim().min(1).max(max)
/** A name as written on an identity document. */
const legalName = text(80)
/** International format: `+`, the country code and the number, e.g. `+393331234567`. */
export const phoneSchema = z
  .string()
  .transform((value) => value.replace(/[\s().-]/g, ""))
  .pipe(z.string().regex(/^\+[1-9]\d{6,14}$/, "A phone number in international format, e.g. +39 333 123 4567"))

/** The bookkeeping data the association keeps. Nullable fields may be missing for a socio registered afterwards. */
const bookkeepingFields = {
  firstName: z.string(),
  lastName: z.string(),
  /** The name the person goes by, shown with the legal name. */
  alias: z.string().nullable(),
  codiceFiscale: z.string().nullable(),
  birthDate: z.string().nullable(),
  /** The comune, or the city and country. */
  birthPlace: z.string().nullable(),
  /** The residence address as one line, as the Libro Soci writes it, e.g. `Via Roma 1, Milano (MI)`. */
  residence: z.string().nullable(),
  /** International format. Never required. */
  phone: z.string().nullable(),
}

/** One row of the register. */
export const socioRowSchema = z.object({
  number: z.number(),
  entraObjectId: z.string(),
  /** Snapshots taken at admission or registration, kept after the account is deleted. */
  mailbox: z.string(),
  displayName: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  alias: z.string().nullable(),
  /** To warn when a new admission belongs to a former socio. */
  codiceFiscale: z.string().nullable(),
  admittedOn: z.string(),
  /** `null` while the socio is active. */
  endedOn: z.string().nullable(),
  endReason: z.enum(END_REASONS).nullable(),
  accountState: z.enum(ACCOUNT_STATES),
  /** Whether the account is in the Soci group now; `null` when Microsoft 365 couldn't be read. */
  inSoci: z.boolean().nullable(),
  /**
   * Where the record and Soci membership disagree: an active record whose account isn't in Soci, or an ended one
   * whose account still is. `null` when they agree, or when Microsoft 365 couldn't be read.
   */
  mismatch: z.enum(["not_in_soci", "still_in_soci"]).nullable(),
})
export type SocioRow = z.infer<typeof socioRowSchema>

export const sociListSchema = z.object({
  members: z.array(socioRowSchema),
  /** False when Microsoft 365 couldn't be read: `inSoci` and `mismatch` are then unknown. */
  directoryAvailable: z.boolean(),
})
export type SociList = z.infer<typeof sociListSchema>

export const activitySchema = z.object({ actor: z.string(), text: z.string(), at: z.string() })
export type SocioActivity = z.infer<typeof activitySchema>

export const socioRecordSchema = socioRowSchema.extend({
  ...bookkeepingFields,
  endNote: z.string().nullable(),
  accountDeletedOn: z.string().nullable(),
  /** The account's current member number in Microsoft 365; `null` when it has none, or couldn't be read. */
  accountNumber: z.string().nullable(),
  /** Newest first. */
  activity: z.array(activitySchema),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string(),
  updatedAt: z.string(),
})
export type SocioRecord = z.infer<typeof socioRecordSchema>

/** A member of the Soci group in Microsoft 365 without a record. */
export const unregisteredSchema = z.object({
  entraObjectId: z.string(),
  displayName: z.string().nullable(),
  givenName: z.string().nullable(),
  surname: z.string().nullable(),
  mail: z.string().nullable(),
  /** The member number Microsoft 365 holds, if any. */
  employeeId: z.string().nullable(),
  /** When the account was created: the suggested admission date. */
  createdDateTime: z.string().nullable(),
})
export type Unregistered = z.infer<typeof unregisteredSchema>

// Inputs.

const blankToNull = (value: string | null | undefined) => (value === undefined || value === "" ? null : value)
const optional = <T extends z.ZodType<string, string>>(schema: T) =>
  z
    .union([z.literal(""), schema])
    .nullish()
    .transform(blankToNull)

function detailsInput<R extends boolean>(required: R) {
  const field = (schema: z.ZodType<string, string>) => (required ? schema : optional(schema))
  return z
    .object({
      firstName: legalName,
      lastName: legalName,
      alias: optional(text(80)),
      codiceFiscale: required ? codiceFiscaleSchema : optional(codiceFiscaleSchema),
      birthDate: field(dateSchema),
      birthPlace: field(text(120)),
      residence: field(text(200)),
      phone: optional(phoneSchema),
    })
    .superRefine((d, ctx) => {
      if (d.codiceFiscale && d.birthDate && !matchesBirthDate(d.codiceFiscale, d.birthDate))
        ctx.addIssue({
          code: "custom",
          path: ["birthDate"],
          message: "The birth date doesn't match the codice fiscale.",
        })
    })
}

/** Everything required but the alias and the phone: for admitting a new socio. */
export const requiredDetailsSchema = detailsInput(true)
/** Only the legal name required: for a socio registered afterwards, and for edits. Empty strings mean unknown. */
export const optionalDetailsSchema = detailsInput(false)
export type SocioDetails = z.output<typeof optionalDetailsSchema>

// Becomes the Entra display name and mail nickname.
const accountName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[\p{L}\p{M}' -]+$/u, "Only letters, spaces, apostrophes and hyphens")

export const admitInputSchema = z.object({
  /** The Microsoft 365 account to create, as in today's form. */
  account: z.object({
    firstName: accountName,
    lastName: accountName,
    mailbox: mailboxSchema.default({ kind: "standard" }),
    /** Where the credentials go. Not stored. */
    sendEmailTo: z.email(),
  }),
  number: memberNumberSchema,
  details: requiredDetailsSchema,
  admittedOn: dateSchema,
})
export type AdmitInput = z.output<typeof admitInputSchema>

export const registerInputSchema = z.object({
  /** An account already in the Soci group, without a record. */
  entraObjectId: z.string().min(1).max(128),
  /**
   * Required only when the account has no member number in Microsoft 365, which then gets this one. Otherwise it
   * may be left out, and must match the account's.
   */
  number: memberNumberSchema.optional(),
  details: optionalDetailsSchema,
  admittedOn: dateSchema,
})
export type RegisterInput = z.output<typeof registerInputSchema>

export const numberInputSchema = z.object({ number: memberNumberSchema })
export type NumberInput = z.output<typeof numberInputSchema>

export const updateInputSchema = z.object({
  number: memberNumberSchema,
  details: optionalDetailsSchema,
  admittedOn: dateSchema,
})
export type UpdateInput = z.output<typeof updateInputSchema>

export const setNumberInputSchema = z.object({
  number: memberNumberSchema,
  newNumber: memberNumberSchema,
  /** Emails the new number there, as Microsoft 365 › Members did. */
  notifyEmail: z.email().optional(),
})
export type SetNumberInput = z.output<typeof setNumberInputSchema>

export const admitResultSchema = z.object({
  number: z.number(),
  entraObjectId: z.string(),
  mailbox: z.string(),
  welcomeMailSent: z.boolean(),
})
export type AdmitResult = z.infer<typeof admitResultSchema>

export const setNumberResultSchema = z.object({ number: z.number(), notificationSent: z.boolean().nullable() })
export type SetNumberResult = z.infer<typeof setNumberResultSchema>
