import { customAlphabet } from "nanoid"

const a1 = customAlphabet("abcdefghijklmnopqrstuvwxyz", 4)
const a2 = customAlphabet("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 4)
const a3 = customAlphabet("1234567890", 4)

export function generatePassword() {
  return shuffleString(`${a1()}${a2()}${a3()}`)
}

/**
 * Shuffles a string using the Fisher-Yates algorithm.
 * @param text The string to shuffle
 * @returns A new shuffled string
 */
function shuffleString(text: string): string {
  // Convert string to an array of characters
  const characters = text.split("")

  for (let i = characters.length - 1; i > 0; i--) {
    // Generate a random index from 0 to i
    const j = Math.floor(Math.random() * (i + 1))

    // Swap elements at indices i and j
    ;[characters[i], characters[j]] = [characters[j], characters[i]]
  }

  // Join the array back into a string
  return characters.join("")
}
