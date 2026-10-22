import z from "zod"

export const MAIL_DOMAIN = "polinetwork.org"

const LOCAL_PART = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/

/** The part before `@polinetwork.org`: lowercase letters, digits, and single dots or hyphens between them. */
export const localPartSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(64)
  .regex(LOCAL_PART, "Only lowercase letters, digits, dots and hyphens")

export const mailboxSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("standard") }),
  z.object({ kind: z.literal("custom"), localPart: localPartSchema }),
])

export type MailboxChoice = z.infer<typeof mailboxSchema>

/** Accents and apostrophes are dropped and spaces removed: "Niccolò", "D'Amico" -> "niccolo.damico". */
function namePart(name: string) {
  return name.normalize("NFD").replace(/\p{M}/gu, "").replace(/['\s]/g, "").toLowerCase()
}

/** `firstname.lastname`, or null when the name has letters an address cannot hold (e.g. "Łukasz"). */
export function standardLocalPart(firstName: string, lastName: string): string | null {
  const localPart = `${namePart(firstName)}.${namePart(lastName)}`
  return LOCAL_PART.test(localPart) && localPart.length <= 64 ? localPart : null
}

export function mailboxLocalPart(firstName: string, lastName: string, mailbox: MailboxChoice) {
  return mailbox.kind === "custom" ? mailbox.localPart : standardLocalPart(firstName, lastName)
}
