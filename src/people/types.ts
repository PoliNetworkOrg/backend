import type { Campaign, CensusEntry, FeeDetail, ImportPreview, PersonRecord, Receipt, Review } from "./contract"

export type Viewer = { sub: string; telegramId: string | null; can: (permission: string) => boolean }
export type Person = Omit<PersonRecord, "fees" | "isMember"> & {
  accountSub: string | null
  azureId: string | null
  feeYears: Record<string, FeeDetail & { rejections: NonNullable<FeeDetail["rejection"]>[]; fileId: string | null }>
  answers: Record<string, { question: string; answer: string }[]>
  reminders: Record<string, string>
  invite: { hash: string; expiresAt: string } | null
  pendingGroupRemovals?: { chatId: string; message: string }[]
}
export type StoredReceipt = Receipt & {
  officerPersonId: string
  originalFileId: string
  signedFileId: string | null
  sha256: string
  requestId: string | null
  recipient: string
}
export type StoredReview = Review & {
  sub: string
  resolved: boolean
  rejectedPersonIds: string[]
  mergedRecord?: Person
}
export type ImportRow = {
  volunteer: {
    admin: boolean
    teams: import("./contract").TeamId[]
    requestedGroups: string[]
    availableAsCapo: boolean
    otherAssociations?: string[]
    studentRepresentative?: string
    privacyVersion: string
    privacyAcceptedOn: string | null
    photoConsent: "granted" | "denied" | null
  }
  row: number
  fingerprint: string
  profile: Person["profile"]
  entry: CensusEntry
  answers: { question: string; answer: string }[]
  personId: string | null
  duplicateId: string | null
  telegramSuggestion: string | null
}
export type StoredImport = {
  id: string
  owner: string
  campaignId: string
  expiresAt: string
  committed: boolean
  rows: ImportRow[]
  preview: ImportPreview
}
export type SignedBatch = {
  id: string
  owner: string
  expiresAt: string
  consumed: boolean
  files: {
    id: string
    fileName: string
    size: number
    receiptId: string | null
    valid: boolean
    signer: string | null
  }[]
}
export type Outbox = {
  id: string
  personId: string
  receiptId: string | null
  to: string
  subject: string
  text: string
  fileId: string | null
  status: "pending" | "sending" | "sent" | "failed"
  attemptedAt: string | null
  error: string | null
}
export type PeopleState = {
  persons: Record<string, Person>
  receipts: Record<string, StoredReceipt>
  campaigns: Record<string, Campaign>
  reviews: Record<string, StoredReview>
  imports: Record<string, StoredImport>
  batches: Record<string, SignedBatch>
  outbox: Record<string, Outbox>
  counters: Record<string, number>
  fingerprints: Record<string, true>
}
export const emptyState = (): PeopleState => ({
  persons: {},
  receipts: {},
  campaigns: {},
  reviews: {},
  imports: {},
  batches: {},
  outbox: {},
  counters: {},
  fingerprints: {},
})
export type StoredFile = {
  id: string
  fileName: string
  contentType: string
  content: Uint8Array
  expiresAt: string | null
}
export type Officer = "president" | "vicePresident"
export type PeopleConfig = {
  officers: Record<Officer, string | null>
  feeCents: number
  beneficiary: string
  iban: string
  legalName: string
  address: string
  taxCode: string
  dashboardUrl: string
}
export type UnitOfWork = {
  state: PeopleState
  getFile(id: string): Promise<StoredFile | null>
  putFile(file: StoredFile): Promise<void>
  deleteFile(id: string): Promise<void>
  prepareRequest(receipt: StoredReceipt, sub: string, signerName: string): Promise<{ requestId: string; title: string }>
  invalidateRequest(receipt: StoredReceipt, actor: string): Promise<void>
}
export interface PeopleStore {
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>
}
export type Account = {
  sub: string
  name: string
  email: string | null
  telegramId: string | null
  emailVerified?: boolean
}
export type TelegramUser = { id: string; name: string; username: string | null }
/** `admins` is null while the bot cannot tell the group's Telegram admins: People then keeps the groups it last knew. */
export type TelegramGroup = { chatId: string; title: string; admins: string[] | null }
