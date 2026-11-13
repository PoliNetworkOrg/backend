import type { ACCOUNT_STATES, END_REASONS, FEE_STATUSES, PAYMENT_METHODS } from "./contract"

/** One admission in the Libro Soci. */
export type Socio = {
  id: number
  number: number
  entraObjectId: string
  mailbox: string
  displayName: string
  firstName: string
  lastName: string
  alias: string | null
  codiceFiscale: string | null
  birthDate: string | null
  birthPlace: string | null
  residence: string | null
  phone: string | null
  admittedOn: string
  endedOn: string | null
  endReason: (typeof END_REASONS)[number] | null
  endNote: string | null
  accountState: (typeof ACCOUNT_STATES)[number]
  accountDeletedOn: string | null
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
}

export type NewSocio = Omit<Socio, "id">
/** The fields an edit may change. */
export type SocioChanges = Partial<Omit<Socio, "id" | "number" | "createdBy" | "createdAt">> &
  Pick<Socio, "updatedBy" | "updatedAt">

export type ActivityEntry = { actor: string; text: string; at: string }

export type FeeStatus = (typeof FEE_STATUSES)[number]

/** One socio's fee for one fee year (`soci_fees`). */
export type StoredFee = {
  id: number
  memberId: number
  year: number
  status: FeeStatus
  amountCents: number
  fileId: string | null
  transferDate: string | null
  declaredCents: number | null
  uploadedAt: string | null
  reviewedBy: string | null
  reviewedAt: string | null
  rejectionReason: string | null
  paidOn: string | null
  method: (typeof PAYMENT_METHODS)[number] | null
  note: string | null
  recordedBy: string | null
  createdAt: string
  updatedAt: string
}
export type NewFee = Omit<StoredFee, "id" | "memberId">
export type FeeChanges = Partial<Omit<StoredFee, "id" | "memberId" | "year" | "createdAt">> &
  Pick<StoredFee, "updatedAt">

/** An uploaded transfer receipt (`soci_files`), kept as a payment record. */
export type StoredFile = {
  id: string
  memberId: number
  fileName: string
  contentType: string
  content: Uint8Array
  uploadedBy: string
  uploadedAt: string
}

export const MAIL_KINDS = ["opening", "reminder", "confirmed", "rejected"] as const
export type MailKind = (typeof MAIL_KINDS)[number]
/** What every fee email shows; `reason` only on a rejection, `paidOn` only on a confirmation. */
export type FeeMailData = {
  name: string
  yearLabel: string
  amount: string
  deadline: string
  iban: string
  beneficiary: string
  reference: string
  myAreaUrl: string
  reason?: string
  paidOn?: string
}

/** An email in the outbox (`soci_mail`). The id is its idempotency key, e.g. `reminder:2026:dec-1:12`. */
export type SociMail = {
  id: string
  memberId: number
  to: string
  kind: MailKind
  data: FeeMailData
  status: "pending" | "sending" | "sent" | "failed"
  createdAt: string
  attemptedAt: string | null
  error: string | null
}
export type NewMail = Pick<SociMail, "id" | "to" | "kind" | "data">

export interface SociStore {
  /** Every record, by number. */
  list(): Promise<Socio[]>
  byNumber(number: number): Promise<Socio | null>
  byObjectId(entraObjectId: string): Promise<Socio | null>
  /** The active record with this codice fiscale, if any. */
  activeByCodiceFiscale(codiceFiscale: string): Promise<Socio | null>
  /** The record that holds or once held this number, if any. */
  numberOwner(number: number): Promise<number | null>
  /** A record's history, newest first. */
  activity(memberId: number): Promise<ActivityEntry[]>
  /** Writes a record, its number, its first history entry and its first fees in one transaction. */
  insert(socio: NewSocio, entry: ActivityEntry, fees?: NewFee[]): Promise<Socio>
  update(memberId: number, changes: SocioChanges, entry: ActivityEntry): Promise<void>
  /** Gives the record a new number, keeping the old one as used. */
  changeNumber(memberId: number, number: number, entry: ActivityEntry): Promise<void>

  /** Fees by socio, by year, or both; newest year first. */
  fees(filter: { memberId?: number; year?: number }): Promise<StoredFee[]>
  /**
   * Opens a fee with its history entry and, optionally, an email, in one transaction. Returns `null`, writing nothing,
   * when the socio already has a fee for that year.
   */
  openFee(memberId: number, fee: NewFee, entry: ActivityEntry, mail?: NewMail): Promise<StoredFee | null>
  /**
   * Changes a fee only while its status is one of `from` (and, when `fee.fileId` is given, while it still holds that
   * upload), with its history entry, an optional email and an optional new file, in one transaction. Returns whether
   * it changed; when it didn't, nothing is written.
   */
  updateFee(
    fee: Pick<StoredFee, "id" | "memberId"> & { fileId?: string | null },
    from: readonly FeeStatus[],
    changes: FeeChanges,
    entry: ActivityEntry,
    mail?: NewMail,
    file?: StoredFile
  ): Promise<boolean>
  file(id: string): Promise<StoredFile | null>
  /** File names and types, without the content. */
  fileNames(ids: string[]): Promise<Map<string, { fileName: string; contentType: string }>>

  /** Queues an email unless one with the same id exists. Returns whether it was queued. */
  enqueue(memberId: number, mail: NewMail, at: string): Promise<boolean>
  /**
   * Marks emails stuck in `sending` since before `staleBefore` as failed, then claims up to `limit` pending emails
   * by marking them `sending` at `at`.
   */
  claimMail(at: string, staleBefore: string, limit: number): Promise<SociMail[]>
  /** Records the outcome of a claimed email, unless another run claimed it since. */
  finishMail(
    mail: Pick<SociMail, "id" | "memberId" | "attemptedAt" | "kind">,
    error: string | null,
    at: string
  ): Promise<void>
}
