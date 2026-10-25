import type { User as TUser } from "@microsoft/microsoft-graph-types"

// this is returned when `/users` is called without `$select` query
export type BasicUser = Pick<
  Required<TUser>,
  | "businessPhones"
  | "displayName"
  | "givenName"
  | "id"
  | "jobTitle"
  | "mail"
  | "mobilePhone"
  | "officeLocation"
  | "preferredLanguage"
  | "surname"
  | "userPrincipalName"
>

// this is the type representing our call to `/users`
export type User = Pick<
  Required<TUser>,
  "displayName" | "mail" | "givenName" | "surname" | "id" | "assignedLicenses" | "employeeId" | "createdDateTime"
>

export type ParsedUser = {
  id: string
  displayName: string | null
  mail: string | null
  givenName: string | null
  surname: string | null
  employeeId: string | null
  /** When the account was created, as Graph returns it; absent in the seeded directory. */
  createdDateTime?: string | null
  isMember: boolean
  assignedLicensesIds: string[]
}

export type ParsedGroup = {
  id: string
  displayName: string
  mailAddress: string | null
  members: Array<{
    id: string
    displayName: string
  }>
}

export type CreateMemberInput = {
  firstName: string
  lastName: string
  assocNumber: number
  /** The part before `@polinetwork.org`, already validated. */
  localPart: string
}

/** The directory fields the member number workflow reads. */
export type MemberSummary = Pick<ParsedUser, "id" | "displayName" | "givenName" | "mail" | "employeeId">

export type CreatedMember = {
  firstName: string
  lastName: string
  id: string
  mail: string
  password: string
}

export type AzureDirectory = {
  getMembers(): Promise<ParsedUser[]>
  /** Null when no user has this id. */
  getMember(userId: string): Promise<MemberSummary | null>
  /** Any user whose `employeeId` is this number. */
  findByMemberNumber(assocNumber: number): Promise<MemberSummary | null>
  /** Any user whose sign-in name or mail is this address. */
  findByMail(mail: string): Promise<MemberSummary | null>
  setMemberNumber(userId: string, assocNumber: number): Promise<{ error: string | null }>
  createMember(input: CreateMemberInput): Promise<CreatedMember>
  getAllGroups(): Promise<ParsedGroup[]>
}
