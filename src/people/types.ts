import type { PersonRecord } from "./contract"

export type Viewer = { sub: string; telegramId: string | null; can: (permission: string) => boolean }
export type Person = PersonRecord & {
  accountSub: string | null
  invite: { hash: string; expiresAt: string } | null
}
export type Outbox = {
  id: string
  personId: string
  to: string
  subject: string
  text: string
  status: "pending" | "sending" | "sent" | "failed"
  attemptedAt: string | null
  error: string | null
}
export type PeopleState = {
  persons: Record<string, Person>
  outbox: Record<string, Outbox>
  counters: Record<string, number>
}
export const emptyState = (): PeopleState => ({
  persons: {},
  outbox: {},
  counters: {},
})
export type UnitOfWork = {
  state: PeopleState
}
export interface PeopleStore {
  transaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>
}
export type Account = {
  sub: string
  name: string
  email: string | null
  telegramId: string | null
}
