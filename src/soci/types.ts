import type { ACCOUNT_STATES, END_REASONS } from "./contract"

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
  /** Writes a record, its number and its first history entry in one transaction. */
  insert(socio: NewSocio, entry: ActivityEntry): Promise<Socio>
  update(memberId: number, changes: SocioChanges, entry: ActivityEntry): Promise<void>
  /** Gives the record a new number, keeping the old one as used. */
  changeNumber(memberId: number, number: number, entry: ActivityEntry): Promise<void>
}
