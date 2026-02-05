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
  "displayName" | "mail" | "givenName" | "surname" | "id" | "assignedLicenses" | "employeeId"
>
