/**
 * The association fee, as the Regolamento Interno sets it (§ Quota associativa). Hard-coded on purpose: changing a
 * rule means changing the Regolamento first. Days are `YYYY-MM-DD` in Europe/Rome.
 */

export const FEE_CENTS = 500
/** Uploaded transfer receipts. */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024

/** The day in Rome. */
export const romeDay = (at: Date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Rome",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at)

const parts = (day: string) => {
  const [year, month, date] = day.split("-").map(Number)
  return { year, month, date }
}

/** The fee year a day falls in, by its first calendar year: 1 September Y – 31 August Y+1 is `Y`. */
export function feeYearOf(day: string) {
  const { year, month } = parts(day)
  return month >= 9 ? year : year - 1
}

/** `2026/27`. */
export const feeYearLabel = (year: number) => `${year}/${String((year + 1) % 100).padStart(2, "0")}`

/** The last day to renew: 31 December of the fee year's first calendar year. */
export const renewalDeadline = (year: number) => `${year}-12-31`

/** Admitted from 1 June to 31 August: the next fee year is exempt. Returns that year, or null. */
export function exemptYearFor(admittedOn: string) {
  const { year, month } = parts(admittedOn)
  return month >= 6 && month <= 8 ? year : null
}

/** The transfer's reason: `Quota 2026/27 0344 Nome Cognome`. */
export const paymentReference = (year: number, number: number, firstName: string, lastName: string) =>
  `Quota ${feeYearLabel(year)} ${String(number).padStart(4, "0")} ${firstName} ${lastName}`

/** `5,00 €`. */
export const formatEuro = (cents: number) =>
  new Intl.NumberFormat("it-IT", { style: "currency", currency: "EUR" }).format(cents / 100)

/** `31 dicembre 2026`. */
export const formatItalianDay = (day: string) =>
  new Intl.DateTimeFormat("it-IT", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).format(
    new Date(`${day}T00:00:00Z`)
  )

/**
 * The reminder due on this day, if any: the 1 December one until the 20th, then the 21 December one. A day the job
 * missed is caught up the next day; each reminder's idempotency key keeps it to one per socio.
 */
export function reminderOn(day: string) {
  const { month, date } = parts(day)
  if (month !== 12) return null
  return date >= 21 ? "dec-21" : "dec-1"
}

/** The day a reminder is for: `2026-12-01` or `2026-12-21`. */
export const reminderDay = (year: number, reminder: "dec-1" | "dec-21") =>
  `${year}-12-${reminder === "dec-1" ? "01" : "21"}`
