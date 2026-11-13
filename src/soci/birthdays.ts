/** Whether `day` is the birthday of someone born on `birthDate` (both `YYYY-MM-DD`). */
export function isBirthday(birthDate: string, day: string) {
  const born = birthDate.slice(5)
  const today = day.slice(5)
  if (born === today) return true
  // Born on 29 February: the 28th in years without a 29th.
  const year = Number(day.slice(0, 4))
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  return born === "02-29" && today === "02-28" && !leap
}
