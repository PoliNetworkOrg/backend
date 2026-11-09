/**
 * The Italian codice fiscale of a natural person: format, omocodia and check character.
 *
 * Sixteen characters: three letters each from the surname and the name, the birth year, a month letter, the birth
 * day (plus 40 for women), the Belfiore code of the birthplace, and the check character. When two people would get
 * the same code (omocodia), the Agenzia delle Entrate replaces digits from the right with letters (`LMNPQRSTUV` for
 * 0–9), so those seven positions may hold either.
 */

const OMOCODIA = "LMNPQRSTUV"
const MONTHS = "ABCDEHLMPRST"
/** Positions that hold a digit, or its omocodia letter. */
const NUMERIC = [6, 7, 9, 10, 12, 13, 14]
const FORMAT = /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/

/** What a character in an odd position (1st, 3rd, …) adds to the check sum. */
const ODD: Record<string, number> = Object.fromEntries(
  [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23].flatMap((value, i) => [
    [String.fromCharCode(65 + i), value],
    ...(i < 10 ? [[String(i), value]] : []),
  ])
)
const even = (char: string) => (char >= "0" && char <= "9" ? Number(char) : char.charCodeAt(0) - 65)

/** Upper case, without spaces: how the code is compared and stored. */
export function normalizeCodiceFiscale(value: string) {
  return value.replace(/\s+/g, "").toUpperCase()
}

/** The check character the first fifteen characters call for. */
export function checkCharacter(first15: string) {
  let sum = 0
  for (let i = 0; i < 15; i++) sum += i % 2 === 0 ? (ODD[first15[i]] ?? 0) : even(first15[i])
  return String.fromCharCode(65 + (sum % 26))
}

/** The code with every omocodia letter turned back into its digit. */
function withDigits(code: string) {
  const chars = [...code]
  for (const i of NUMERIC) {
    const digit = OMOCODIA.indexOf(chars[i])
    if (digit >= 0) chars[i] = String(digit)
  }
  return chars.join("")
}

export type CodiceFiscaleProblem = "format" | "check" | "date"

/** Why the code is not valid, or null. Expects a normalized code. */
export function codiceFiscaleProblem(code: string): CodiceFiscaleProblem | null {
  if (!FORMAT.test(code)) return "format"
  if (checkCharacter(code.slice(0, 15)) !== code[15]) return "check"
  const birth = encodedBirth(code)
  if (!birth) return "date"
  return null
}

/** The birth data a valid code encodes: the year only to two digits. Null when the day can't exist. */
export function encodedBirth(code: string): { yy: number; month: number; day: number; female: boolean } | null {
  const plain = withDigits(code)
  const yy = Number(plain.slice(6, 8))
  const month = MONTHS.indexOf(plain[8]) + 1
  const rawDay = Number(plain.slice(9, 11))
  const female = rawDay > 40
  const day = female ? rawDay - 40 : rawDay
  // 29 February is allowed here: the year isn't known to the century.
  const days = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (day < 1 || day > days) return null
  return { yy, month, day, female }
}

/** Whether a valid code agrees with a birth date (`YYYY-MM-DD`). */
export function matchesBirthDate(code: string, birthDate: string) {
  const birth = encodedBirth(code)
  if (!birth) return false
  const [year, month, day] = birthDate.split("-").map(Number)
  return birth.yy === year % 100 && birth.month === month && birth.day === day
}
